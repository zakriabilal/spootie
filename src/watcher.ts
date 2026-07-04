import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Extensions macOS ever saves screenshots (or screenshot-derived images) as.
 * This is deliberately just an extension allowlist — it says nothing about
 * *who* wrote the file. `.mov` screen recordings are excluded by omission.
 * Whether a candidate is actually a screen capture is decided later via
 * Spotlight metadata (see `isSpotlightScreenCapture`), because the default
 * "Screenshot " filename prefix is US-English-only: localized macOS systems
 * name them differently (e.g. "Bildschirmfoto ..." in German), and users can
 * rename the prefix entirely via
 * `defaults write com.apple.screencapture name "..."`.
 */
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|heic|tiff|gif)$/i;

/**
 * Legacy US-English default screenshot filename shape, e.g.:
 *   "Screenshot 2026-07-03 at 20.14.30.png"
 *   "Screenshot 2026-07-03 at 20.14.30 (2).png"
 * Checked FIRST, before any Spotlight probe: a match is accepted immediately
 * with zero `mdls` spawns, since this is the common case on default
 * US-English systems and the pattern is unambiguous. Spotlight's
 * kMDItemIsScreenCapture (see `isSpotlightScreenCapture`) is only consulted
 * for names that don't match this pattern — localized systems (e.g.
 * "Bildschirmfoto ..." in German) or a custom
 * `defaults write com.apple.screencapture name "..."` prefix.
 */
const SCREENSHOT_NAME_RE = /^Screenshot .+\.(png|jpg|jpeg|heic|tiff|gif)$/i;

/** Number of stable-size polls required before we treat a file as finished. */
const STABLE_POLLS = 3;
/** Delay between size polls, in ms. */
const POLL_INTERVAL_MS = 250;

/**
 * Per-probe timeout for a single `mdls` spawn. A wedged `mdls` (e.g. Spotlight
 * indexing hung) would otherwise hold a probe-slot semaphore permit forever;
 * enough of those silently disables Spotlight detection for the rest of the
 * daemon's life. On timeout the process is killed and the probe is treated as
 * "unavailable".
 */
const MDLS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Spotlight (mdls) tags a freshly-written screen capture with
 * kMDItemIsScreenCapture, but it does so asynchronously and sometimes lands
 * a moment after the file's bytes have already stopped changing. We poll for
 * up to ~5s (10 attempts, 500ms apart between attempts) before giving up and
 * falling back to the filename heuristic.
 */
const MDLS_POLL_ATTEMPTS = 10;
const MDLS_POLL_INTERVAL_MS = 500;

/**
 * Cap on concurrently-running Spotlight probe loops. Each loop can spawn up
 * to MDLS_POLL_ATTEMPTS `mdls` processes over ~5s; without a cap, a burst of
 * many non-default-named images landing at once (e.g. a big AirDrop) would
 * fan out dozens of concurrent `mdls` spawns. A small promise-based
 * semaphore keeps that bounded without pulling in a dependency.
 */
const MAX_CONCURRENT_SPOTLIGHT_PROBES = 3;
let activeSpotlightProbes = 0;
const spotlightProbeWaiters: Array<() => void> = [];

const acquireSpotlightProbeSlot = (): Promise<void> => {
    if (activeSpotlightProbes < MAX_CONCURRENT_SPOTLIGHT_PROBES) {
        activeSpotlightProbes++;
        return Promise.resolve();
    }
    return new Promise((resolve) => spotlightProbeWaiters.push(resolve));
};

const releaseSpotlightProbeSlot = (): void => {
    const next = spotlightProbeWaiters.shift();
    if (next) {
        // Hand the slot directly to the next waiter rather than decrementing,
        // so activeSpotlightProbes stays an accurate count of running loops.
        next();
    } else {
        activeSpotlightProbes--;
    }
};

/**
 * Only files that reach the Spotlight-gated path (i.e. their name did NOT
 * match the legacy filename pattern) are subject to this check. A screenshot
 * copied, AirDropped, or synced in from elsewhere can still carry
 * kMDItemIsScreenCapture in its metadata, so Spotlight alone would also fire
 * on old screen captures being moved into the watched folder, not just fresh
 * ones. Finder copies and synced files preserve the original birthtime, so
 * gating on a recent birthtime rejects those while still passing genuinely
 * new captures. Product rationale: every match here only prompts the user to
 * confirm an upload (nothing auto-uploads), so the residual risk of a fresh
 * foreign screen-capture slipping through is just an extra confirmation
 * prompt, not a privacy leak.
 */
const SPOTLIGHT_MAX_AGE_MS = 2 * 60_000;
const isRecentBirth = (birthtimeMs: number): boolean =>
    Date.now() - birthtimeMs <= SPOTLIGHT_MAX_AGE_MS;

/**
 * How long to remember a screenshot we've already handed to `onScreenshot`, so
 * the burst of late fs events macOS fires for a fresh screenshot AFTER its
 * pixels settle (xattr/quarantine writes, the floating-thumbnail finalization
 * rename) don't re-trigger a second confirm/upload. Generous on purpose: those
 * trailing events land within a few seconds, but a large margin costs nothing.
 */
const HANDLED_TTL_MS = 60_000;

/**
 * Identity of a settled file on disk. We key the "already handled" cooldown on
 * this rather than the path alone so that a genuinely NEW screenshot which
 * later reuses the same name (a different inode/birthtime) is still handled,
 * while repeated events for the very same file are ignored.
 */
interface FileIdentity {
    ino: number;
    birthtimeMs: number;
}

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
    a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

/**
 * Resolve the folder macOS saves screenshots into. Uses the user's configured
 * `com.apple.screencapture location`, falling back to ~/Desktop.
 */
export const getScreenshotFolder = (): string => {
    const result = spawnSync("defaults", ["read", "com.apple.screencapture", "location"], {
        encoding: "utf8",
    });

    const value = result.stdout?.trim();
    if (result.status === 0 && value) {
        // The stored path may use "~" for the home directory.
        return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
    }

    return join(homedir(), "Desktop");
};

/**
 * Cheap, filename-only pre-filter: does `name` look like it could possibly be
 * a screenshot? This intentionally accepts *any* image with a plausible
 * extension (not just the "Screenshot " prefix) since the real decision is
 * made later via Spotlight metadata — this just avoids spawning `mdls` for
 * obviously-irrelevant files (dotfiles, non-image files, `.mov` recordings).
 */
export const isCandidateScreenshotFile = (name: string): boolean => {
    // Ignore hidden dotfiles (e.g. in-progress ".Screenshot ..." temp files).
    if (name.startsWith(".")) return false;
    return IMAGE_EXT_RE.test(name);
};

/** Tri-state result of a single `mdls` probe for kMDItemIsScreenCapture. */
type ScreenCaptureProbe = "yes" | "pending" | "unavailable";

/**
 * Ask Spotlight, once, whether `path` is tagged as a screen capture. Returns
 * "pending" when the attribute hasn't been written yet (mdls prints
 * "(null)"), and "unavailable" when `mdls` itself failed or isn't present
 * (e.g. Spotlight indexing disabled for the volume) — callers should treat
 * "unavailable" as "stop polling, this file is not confirmed as a screen
 * capture" (only reached for names that already failed the filename check).
 */
const probeIsScreenCapture = async (path: string): Promise<ScreenCaptureProbe> => {
    try {
        const proc = Bun.spawn(["mdls", "-raw", "-name", "kMDItemIsScreenCapture", path], {
            stdout: "pipe",
            stderr: "ignore",
        });
        // Start draining stdout without awaiting it yet: awaiting it here would
        // block on a wedged `mdls` that never closes stdout, before the timeout
        // race below even gets a chance to run.
        const outputPromise = new Response(proc.stdout).text().catch(() => "");

        // Bound the wait on the process exiting: a wedged `mdls` would otherwise
        // hold this probe's semaphore slot forever, and enough wedged probes over
        // time would silently disable Spotlight detection for the rest of the
        // daemon's life. This timeout bounds the whole probe, including a stdout
        // stream that never closes, since the read above is never awaited before
        // the race resolves.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = Symbol("mdls-probe-timeout");
        const timeout = new Promise<typeof timedOut>((resolve) => {
            timer = setTimeout(() => resolve(timedOut), MDLS_PROBE_TIMEOUT_MS);
        });
        const exitCode = await Promise.race([proc.exited, timeout]);
        if (exitCode === timedOut) {
            proc.kill();
            return "unavailable";
        }
        clearTimeout(timer);

        if (exitCode !== 0) return "unavailable";
        const output = (await outputPromise).trim();
        // `mdls -raw` prints "1", "0", or "(null)" for boolean attributes — never
        // the string "true".
        return output === "1" ? "yes" : "pending";
    } catch {
        // `mdls` missing or failed to spawn.
        return "unavailable";
    }
};

/**
 * Determine whether `path` is a genuine macOS screen capture via Spotlight's
 * kMDItemIsScreenCapture attribute, polling briefly since Spotlight can tag
 * the file a little after its bytes settle. Returns false (rather than
 * throwing) if Spotlight never confirms. Only called for names that didn't
 * already match `SCREENSHOT_NAME_RE`; callers must additionally apply the
 * birthtime recency guard (see `isRecentBirth`) before treating this as
 * confirmation.
 */
export const isSpotlightScreenCapture = async (path: string): Promise<boolean> => {
    await acquireSpotlightProbeSlot();
    try {
        for (let attempt = 0; attempt < MDLS_POLL_ATTEMPTS; attempt++) {
            const result = await probeIsScreenCapture(path);
            if (result === "yes") return true;
            if (result === "unavailable") return false;
            // Don't sleep after the last attempt — there's no further poll to wait
            // for, so it would just add 500ms of pure waste before returning false.
            if (attempt < MDLS_POLL_ATTEMPTS - 1) {
                await Bun.sleep(MDLS_POLL_INTERVAL_MS);
            }
        }
        return false;
    } finally {
        releaseSpotlightProbeSlot();
    }
};

/**
 * Wait until a file exists and its size has been stable across several polls,
 * so we don't act on a screenshot that macOS is still writing. Returns the
 * settled file's identity (inode + birthtime), or null if the file never
 * settled (e.g. it was removed).
 */
const waitForStableFile = async (path: string): Promise<FileIdentity | null> => {
    let lastSize = -1;
    let stableCount = 0;
    let identity: FileIdentity | null = null;
    const maxAttempts = 80; // ~20s ceiling at 250ms per poll.

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let size: number;
        try {
            const info = await stat(path);
            size = info.size;
            identity = { ino: info.ino, birthtimeMs: info.birthtimeMs };
        } catch {
            // File not there (yet or anymore) — reset and keep trying briefly.
            lastSize = -1;
            stableCount = 0;
            identity = null;
            await Bun.sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (size > 0 && size === lastSize) {
            stableCount++;
            if (stableCount >= STABLE_POLLS) return identity;
        } else {
            stableCount = 0;
        }

        lastSize = size;
        await Bun.sleep(POLL_INTERVAL_MS);
    }

    return null;
};

export interface WatchHandle {
    close(): void;
}

/**
 * Watch `folder` for newly saved macOS screenshots. Candidate images are
 * confirmed as genuine screen captures via the legacy filename pattern first,
 * falling back to Spotlight metadata (plus a recency guard) for names that
 * don't match, so this works with localized macOS systems and custom
 * screenshot filename prefixes, not just the US-English default. Each
 * settled screenshot's absolute path is passed to `onScreenshot` exactly once.
 */
export const watchScreenshots = (
    folder: string,
    onScreenshot: (path: string) => void,
): WatchHandle => {
    // Paths whose stability-poll loop is currently running, so overlapping fs
    // events don't spawn a second poller for the same in-progress screenshot.
    const polling = new Set<string>();
    // Screenshots we've already dispatched, keyed by path, with the file identity
    // we saw and when. macOS keeps emitting events for a screenshot (metadata and
    // xattr writes, the floating-thumbnail finalization rename) for a few seconds
    // AFTER its pixels settle; without this those late events would re-poll the
    // already-stable file and trigger a duplicate confirm/upload. We compare
    // identity so a genuinely new file reusing the name later is still handled.
    const handled = new Map<string, { identity: FileIdentity; at: number }>();

    const watcher = watch(folder, (_eventType, filename) => {
        if (!filename) return;
        const name = basename(filename.toString());
        if (!isCandidateScreenshotFile(name)) return;

        const path = join(folder, name);
        if (polling.has(path)) return;
        polling.add(path);

        void (async () => {
            try {
                const identity = await waitForStableFile(path);
                if (identity === null) return;

                // Confirm this is an actual screen capture, not just an
                // arbitrarily-named image dropped into the folder. Check the cheap
                // legacy English filename pattern FIRST: if it matches, accept
                // immediately with zero `mdls` spawns (this is the common case on
                // default US-English systems, and skips the ~5s Spotlight poll
                // entirely). Only fall through to the Spotlight probe — plus a
                // recency guard, since Spotlight tags copied-in files too — for
                // names that don't match.
                if (!SCREENSHOT_NAME_RE.test(name)) {
                    const spotlightConfirmed = await isSpotlightScreenCapture(path);
                    if (!spotlightConfirmed) {
                        // Distinguish this from the recency-guard rejection below: this
                        // case means Spotlight either never tagged the file within the
                        // ~5s poll (indexing backlog) or isn't available at all, so a
                        // legitimate localized/custom-named screenshot can be silently
                        // dropped here with no other trace.
                        console.log(
                            `spootie: ${name} was not confirmed as a screen capture (Spotlight timeout or unavailable); ignoring`,
                        );
                        return;
                    }
                    if (!isRecentBirth(identity.birthtimeMs)) {
                        console.log(
                            `spootie: ${name} is tagged as a screen capture by Spotlight but is not recent (likely copied/synced in); ignoring`,
                        );
                        return;
                    }
                }

                // The gate above can take up to ~5s (Spotlight polling). Re-stat
                // immediately before dispatch: the file may have been deleted or
                // renamed away during that window, in which case there is nothing
                // left to upload. Use this fresh identity (not the pre-gate one) for
                // the handled-dedupe map so trailing finalization-rename events
                // still dedupe correctly against what we actually dispatched.
                let freshIdentity: FileIdentity;
                try {
                    const info = await stat(path);
                    freshIdentity = { ino: info.ino, birthtimeMs: info.birthtimeMs };
                } catch {
                    console.log(`spootie: ${path} disappeared before dispatch, skipping`);
                    return;
                }

                const now = Date.now();
                // Drop stale entries so the map can't grow without bound.
                for (const [p, entry] of handled) {
                    if (now - entry.at > HANDLED_TTL_MS) handled.delete(p);
                }

                const prev = handled.get(path);
                if (
                    prev !== undefined &&
                    now - prev.at <= HANDLED_TTL_MS &&
                    sameIdentity(prev.identity, freshIdentity)
                ) {
                    // A trailing event for a screenshot we already handled — ignore it.
                    return;
                }

                handled.set(path, { identity: freshIdentity, at: now });
                onScreenshot(path);
            } finally {
                polling.delete(path);
            }
        })();
    });

    return {
        close() {
            watcher.close();
        },
    };
};
