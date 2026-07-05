import { chmod, mkdir, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Data directory shared by the queue, pause flag and upload history. */
export const DATA_DIR = join(homedir(), ".config", "spootie", "state");

export const PAUSE_PATH = join(DATA_DIR, "paused");

/**
 * Create a directory (and parents) private to the current user (0700), and
 * enforce 0700 even if it already existed. mkdir's `mode` is ignored for a
 * pre-existing directory, so without the chmod other local users could read
 * the secrets kept under ~/.config/spootie (share URLs in history.json, the
 * dashboard port/token in ui.json, upload URLs in the daemon log).
 */
export const ensurePrivateDir = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
};

// --- migration from the legacy state location --------------------------------

const LEGACY_DATA_DIR = join(homedir(), "Library", "Application Support", "spootie");
// last-upload.json is a legacy single-record file; it is moved here so
// migrateLastUpload() (history.ts) can fold it into history.json.
const STATE_FILES = ["queue.json", "paused", "last-upload.json"] as const;

/**
 * Best-effort move of state files from the legacy
 * ~/Library/Application Support/spootie/ location into DATA_DIR. Files that
 * already exist at the new location win; every error is ignored so migration
 * can never block a command from running.
 */
export const migrateLegacyState = async (): Promise<void> => {
    for (const name of STATE_FILES) {
        try {
            const oldPath = join(LEGACY_DATA_DIR, name);
            const newPath = join(DATA_DIR, name);
            if (!(await Bun.file(oldPath).exists())) continue;
            if (await Bun.file(newPath).exists()) continue;
            await ensurePrivateDir(DATA_DIR);
            await rename(oldPath, newPath);
        } catch {
            // Best-effort only.
        }
    }
    // Remove the legacy directory if it is now empty (fails otherwise; ignore).
    await rmdir(LEGACY_DATA_DIR).catch(() => {});
};

// --- pause flag (cross-process: CLI writes it, the daemon polls it) ----------

export const isPaused = (): Promise<boolean> => Bun.file(PAUSE_PATH).exists();

export const setPaused = async (paused: boolean): Promise<void> => {
    if (paused) {
        await ensurePrivateDir(DATA_DIR);
        await Bun.write(PAUSE_PATH, "");
    } else {
        await unlink(PAUSE_PATH).catch(() => {});
    }
};
