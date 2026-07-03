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
 * Resolve the folder macOS saves screenshots into. Uses the user's configured
 * `com.apple.screencapture location`, falling back to ~/Desktop.
 */
export function getScreenshotFolder(): string {
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
}

export function isScreenshotName(name: string): boolean {
  // Ignore hidden dotfiles (e.g. in-progress ".Screenshot ..." temp files).
  if (name.startsWith(".")) return false;
  return SCREENSHOT_RE.test(name);
}

/**
 * Wait until a file exists and its size has been stable across several polls,
 * so we don't act on a screenshot that macOS is still writing. Returns the
 * final byte size, or null if the file never settled (e.g. it was removed).
 */
async function waitForStableFile(path: string): Promise<number | null> {
  let lastSize = -1;
  let stableCount = 0;
  const maxAttempts = 80; // ~20s ceiling at 250ms per poll.

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let size: number;
    try {
      const info = await stat(path);
      size = info.size;
    } catch {
      // File not there (yet or anymore) — reset and keep trying briefly.
      lastSize = -1;
      stableCount = 0;
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (size > 0 && size === lastSize) {
      stableCount++;
      if (stableCount >= STABLE_POLLS) return size;
    } else {
      stableCount = 0;
    }

    lastSize = size;
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  return null;
}

export interface WatchHandle {
  close(): void;
}

/**
 * Watch `folder` for newly saved macOS screenshots. Each settled screenshot's
 * absolute path is passed to `onScreenshot` exactly once.
 */
export function watchScreenshots(
  folder: string,
  onScreenshot: (path: string) => void,
): WatchHandle {
  // Files we're already handling (stability-polling or done), so overlapping
  // fs events for the same screenshot don't trigger duplicate work.
  const inFlight = new Set<string>();

  const watcher = watch(folder, (_eventType, filename) => {
    if (!filename) return;
    const name = basename(filename.toString());
    if (!isScreenshotName(name)) return;

    const path = join(folder, name);
    if (inFlight.has(path)) return;
    inFlight.add(path);

    void (async () => {
      try {
        const size = await waitForStableFile(path);
        if (size !== null) onScreenshot(path);
      } finally {
        // Allow re-processing if a later file reuses the same name.
        inFlight.delete(path);
      }
    })();
  });

  return {
    close() {
      watcher.close();
    },
  };
}
