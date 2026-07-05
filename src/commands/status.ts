import { CONFIG_PATH, loadConfig, type Config } from "../lib/config.ts";
import {
    errorMessage,
    isAccessDenied,
    isBadCredentials,
    isRetryableNetworkError,
} from "../lib/errors.ts";
import { readHistory, readLastUpload } from "../lib/history.ts";
import { isAgentInstalled, isAgentLoaded } from "./launchagent.ts";
import { readQueueLength } from "../daemon/queue.ts";
import { readUiInfoRaw, uiUrl } from "../daemon/server.ts";
import { fetchLifecycleRules, LIFECYCLE_RULE_ID } from "./setup.ts";
import { isPaused } from "../lib/state.ts";
import { countBucketObjects, makeClient } from "../lib/upload.ts";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

/**
 * Upper bound for every R2 call `spootie status` makes, applied via an
 * AbortSignal per call. Without it, `status` would hang for the SDK's full
 * retry budget when the machine is offline; with it, each check fails fast and
 * degrades to "unreachable" so the report always prints promptly.
 */
const R2_TIMEOUT_MS = 8_000;

type Marker = "✓" | "✗" | "-";

/** One aligned report line: a status marker, a label, and its value. */
const LABEL_WIDTH = 12;
const row = (marker: Marker, label: string, value: string): string =>
    `  ${marker} ${label.padEnd(LABEL_WIDTH)}${value}`;

/**
 * `spootie status`: a health report across setup, R2 auth, the expiry
 * lifecycle rule, the LaunchAgent, the running daemon, the offline queue and
 * upload counts. Designed never to crash or hang — a failing check is reported
 * as information, and every R2 call is time-bounded — so the report itself
 * always prints and the command exits 0.
 */
export const runStatus = async (): Promise<void> => {
    const lines: string[] = [];

    // --- config ------------------------------------------------------------
    let config: Config | null = null;
    try {
        config = await loadConfig();
    } catch {
        config = null;
    }

    lines.push("Config");
    if (config === null) {
        lines.push(row("✗", "config", "not configured — run spootie setup"));
    } else {
        lines.push(row("✓", "config", CONFIG_PATH));
    }

    // --- R2 checks (auth, lifecycle, exposed) ------------------------------
    // Only meaningful with a config; skipped gracefully otherwise so status
    // never touches the network when there are no credentials to use.
    if (config !== null) {
        lines.push("");
        lines.push("R2");
        await appendR2Lines(lines, config);
    }

    // --- daemon & queue ----------------------------------------------------
    lines.push("");
    lines.push("Daemon & queue");
    lines.push(await launchAgentLine());
    lines.push(await daemonLine());
    lines.push(row("-", "paused", (await isPaused()) ? "yes" : "no"));
    const queueLength = await readQueueLength();
    lines.push(row("-", "queue", `${queueLength} pending upload(s)`));

    // --- history -----------------------------------------------------------
    lines.push("");
    lines.push("History");
    const last = await readLastUpload();
    lines.push(row("-", "last upload", last ? `${last.uploadedAt} (${last.url})` : "none yet"));
    const historyCount = (await readHistory()).length;
    lines.push(row("-", "uploads", `${historyCount} recorded`));

    console.log(lines.join("\n"));
};

// --- R2 section --------------------------------------------------------------

type AuthResult = { ok: true } | { ok: false; label: string };

/** Append the auth, lifecycle and exposed rows for a configured install. */
const appendR2Lines = async (lines: string[], config: Config): Promise<void> => {
    const auth = await checkAuth(config);
    if (auth.ok) {
        lines.push(row("✓", "auth", "credentials valid"));
    } else {
        lines.push(row("✗", "auth", auth.label));
    }

    // Both remaining checks hit R2; if we couldn't even authenticate, they will
    // fail the same way, so skip them (and keep status fast when offline).
    if (!auth.ok) {
        lines.push(row("-", "lifecycle", "skipped (auth failed)"));
        lines.push(row("-", "exposed", "skipped (auth failed)"));
        return;
    }

    lines.push(await lifecycleLine(config));
    lines.push(await exposedLine(config));
};

/**
 * Light credential probe: a one-key ListObjectsV2. Classifies failure via the
 * shared error helpers so the report can distinguish bad credentials from an
 * unreachable network from anything else.
 */
const checkAuth = async (config: Config): Promise<AuthResult> => {
    const signal = AbortSignal.timeout(R2_TIMEOUT_MS);
    try {
        const client = makeClient(config);
        await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }), {
            abortSignal: signal,
        });
        return { ok: true };
    } catch (err) {
        if (isBadCredentials(err)) return { ok: false, label: "credentials rejected by R2" };
        if (signal.aborted || isRetryableNetworkError(err)) {
            return { ok: false, label: "R2 unreachable (network)" };
        }
        return { ok: false, label: errorMessage(err) };
    }
};

/** The lifecycle-rule row: expiry present, missing, or uncheckable. */
const lifecycleLine = async (config: Config): Promise<string> => {
    const signal = AbortSignal.timeout(R2_TIMEOUT_MS);
    try {
        const client = makeClient(config);
        const rules = await fetchLifecycleRules(client, config, { abortSignal: signal });
        const rule = rules.find((r) => r.ID === LIFECYCLE_RULE_ID);
        const days = rule?.Expiration?.Days;
        if (days !== undefined) {
            return row("✓", "lifecycle", `expiry rule: ${days} days`);
        }
        return row("✗", "lifecycle", "missing — run spootie setup");
    } catch (err) {
        // Mirror setup's classification: an AccessDenied means the token can't
        // read bucket-level config, which is a distinct, benign case.
        if (isAccessDenied(err)) {
            return row("-", "lifecycle", "cannot check (token lacks bucket permissions)");
        }
        if (signal.aborted || isRetryableNetworkError(err)) {
            return row("-", "lifecycle", "cannot check (R2 unreachable)");
        }
        return row("-", "lifecycle", `cannot check (${errorMessage(err)})`);
    }
};

/** The exposed-object-count row (counts the whole bucket). */
const exposedLine = async (config: Config): Promise<string> => {
    const signal = AbortSignal.timeout(R2_TIMEOUT_MS);
    try {
        const count = await countBucketObjects(config, { abortSignal: signal });
        return row("-", "exposed", `${count} object(s) live in bucket (whole bucket)`);
    } catch (err) {
        if (signal.aborted || isRetryableNetworkError(err)) {
            return row("-", "exposed", "cannot check (R2 unreachable)");
        }
        return row("-", "exposed", `cannot check (${errorMessage(err)})`);
    }
};

// --- daemon & LaunchAgent ----------------------------------------------------

/** True if a process with the given pid exists (macOS/Linux signal-0 probe). */
const isPidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but we may not signal it — still alive.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
};

const launchAgentLine = async (): Promise<string> => {
    if (!(await isAgentInstalled())) return row("-", "launchagent", "not installed");
    return isAgentLoaded()
        ? row("✓", "launchagent", "installed and loaded")
        : row("✗", "launchagent", "installed (not loaded)");
};

/**
 * The daemon row. Distinguishes three states from the raw ui.json record: no
 * record (not running), a record whose pid is alive (running — with the
 * dashboard URL), and a record whose pid is dead (a stale file left by a crash).
 */
const daemonLine = async (): Promise<string> => {
    const info = await readUiInfoRaw();
    if (info === null) return row("-", "daemon", "not running");
    if (isPidAlive(info.pid)) {
        return row("✓", "daemon", `running — ${uiUrl(info.port, info.token)}`);
    }
    return row("✗", "daemon", "not running (stale state)");
};
