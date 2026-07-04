/**
 * macOS notifications.
 *
 * Actionable notifications (with an "Upload" button) use `alerter`, a small
 * notification CLI that blocks until the user interacts and reports which
 * action was taken. Plain notifications use AppleScript's `display
 * notification`, which is fire-and-forget.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ALERTER_ASSET } from "./embedded-assets.ts";
import { extractExecutable } from "./extract-asset.ts";

const APP_TITLE = "spootie";

/** How long the actionable notification stays interactive, in seconds. */
const ACTION_TIMEOUT_SECONDS = 60;

/**
 * Where the embedded alerter binary is extracted to before it is spawned —
 * $bunfs paths (what ALERTER_ASSET resolves to in a compiled binary) cannot
 * be posix_spawn'd. Extraction runs the same way in dev (there it just
 * copies vendor/alerter once), so there is a single code path everywhere.
 */
const EXTRACTED_ALERTER = join(homedir(), ".config", "spootie", "bin", "alerter");

// Extraction is lazy (only happens the first time a notification actually
// needs to spawn alerter) and memoized, so commands that never notify (e.g.
// `spootie status`, or the bare usage message) never touch the filesystem
// for this.
let extractedAlerterPath: Promise<string> | null = null;
const resolveAlerterPath = (): Promise<string> => {
    if (extractedAlerterPath === null) {
        extractedAlerterPath = extractExecutable(ALERTER_ASSET, EXTRACTED_ALERTER).catch((err) => {
            // Don't let a transient failure (e.g. ENOSPC, unwritable dir) wedge
            // every future notification for the daemon's lifetime — clear the
            // memo so the next call retries, while still failing this call.
            extractedAlerterPath = null;
            throw err;
        });
    }
    return extractedAlerterPath;
};

interface AlerterResult {
    activationType?: string;
    activationValue?: string;
}

/**
 * Show a notification with an "Upload" action button and wait for the user.
 * Resolves true if the user clicks "Upload" or the notification body; false
 * if they dismiss, ignore, or it times out.
 */
export const confirmUpload = (fileName: string): Promise<boolean> =>
    askAction("New screenshot", fileName, "Upload");

/**
 * After a queued upload completes, offer to copy its URL (we must not clobber
 * the clipboard unprompted). Resolves true if the user clicks "Copy URL" or
 * the notification body.
 */
export const offerCopyUrl = (url: string): Promise<boolean> =>
    askAction("Queued upload finished", url, "Copy URL");

/**
 * Show an actionable notification with a single affirmative button and wait.
 * Resolves true if the user clicks the button or the notification body; false
 * if they dismiss, ignore, or it times out.
 */
const askAction = async (subtitle: string, message: string, action: string): Promise<boolean> => {
    const alerter = await resolveAlerterPath();

    const proc = Bun.spawn(
        [
            alerter,
            "--json",
            "--title",
            APP_TITLE,
            "--subtitle",
            subtitle,
            "--message",
            message,
            "--actions",
            action,
            "--timeout",
            String(ACTION_TIMEOUT_SECONDS),
        ],
        { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    let result: AlerterResult;
    try {
        result = JSON.parse(stdout.trim()) as AlerterResult;
    } catch {
        // Unparseable output — treat as "no action taken".
        return false;
    }

    // The single action is the only affirmative choice, so a click on the
    // notification body also counts — the action button is only visible on
    // hover and only with the "Alerts" notification style.
    if (result.activationType === "contentsClicked") return true;
    return result.activationType === "actionClicked" && result.activationValue === action;
};

/** Fire-and-forget informational notification. */
export const notify = (message: string, subtitle?: string): void => {
    displayNotification(message, subtitle);
};

/** Fire-and-forget error notification. */
export const notifyError = (message: string): void => {
    displayNotification(message, "Error");
};

const displayNotification = (message: string, subtitle?: string): void => {
    const script =
        `display notification ${quote(message)} ` +
        `with title ${quote(APP_TITLE)}` +
        (subtitle ? ` subtitle ${quote(subtitle)}` : "");

    // Detached and non-blocking; we don't care about the result.
    Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
    });
};

/** Quote a string for safe embedding in an AppleScript literal. */
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
