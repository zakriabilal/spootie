import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * macOS default screenshot file names look like:
 *   "Screenshot 2026-07-03 at 20.14.30.png"
 *   "Screenshot 2026-07-03 at 20.14.30 (2).png"
 * We match the "Screenshot " prefix plus a common image extension. This
 * intentionally excludes "Screen Recording ....mov" files.
 */
const SCREENSHOT_RE = /^Screenshot .+\.(png|jpg|jpeg|heic|tiff|gif)$/i;

/** Number of stable-size polls required before we treat a file as finished. */
const STABLE_POLLS = 3;
/** Delay between size polls, in ms. */
const POLL_INTERVAL_MS = 250;

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
  const result = spawnSync(
    "defaults",
    ["read", "com.apple.screencapture", "location"],
    { encoding: "utf8" },
  );

  const value = result.stdout?.trim();
  if (result.status === 0 && value) {
    // The stored path may use "~" for the home directory.
    return value.startsWith("~")
      ? join(homedir(), value.slice(1))
      : value;
  }

  return join(homedir(), "Desktop");
};

export const isScreenshotName = (name: string): boolean => {
  // Ignore hidden dotfiles (e.g. in-progress ".Screenshot ..." temp files).
  if (name.startsWith(".")) return false;
  return SCREENSHOT_RE.test(name);
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
 * Watch `folder` for newly saved macOS screenshots. Each settled screenshot's
 * absolute path is passed to `onScreenshot` exactly once.
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
    if (!isScreenshotName(name)) return;

    const path = join(folder, name);
    if (polling.has(path)) return;
    polling.add(path);

    void (async () => {
      try {
        const identity = await waitForStableFile(path);
        if (identity === null) return;

        const now = Date.now();
        // Drop stale entries so the map can't grow without bound.
        for (const [p, entry] of handled) {
          if (now - entry.at > HANDLED_TTL_MS) handled.delete(p);
        }

        const prev = handled.get(path);
        if (
          prev !== undefined &&
          now - prev.at <= HANDLED_TTL_MS &&
          sameIdentity(prev.identity, identity)
        ) {
          // A trailing event for a screenshot we already handled — ignore it.
          return;
        }

        handled.set(path, { identity, at: now });
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
