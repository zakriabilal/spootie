import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR, ensurePrivateDir } from "./state.ts";
import { errorMessage } from "./errors.ts";

/** Persistent history of successful uploads, newest first. */
export const HISTORY_PATH = join(DATA_DIR, "history.json");

/** Pre-history single-record file, superseded by history.json. */
const LAST_UPLOAD_PATH = join(DATA_DIR, "last-upload.json");

/** Most recent entries kept; older ones are dropped when the cap is exceeded. */
const MAX_ENTRIES = 500;

export interface HistoryEntry {
  /** The R2 object key — also serves as this item's stable id. */
  key: string;
  /** Public share URL. */
  url: string;
  /** Original local file name. */
  fileName: string;
  /** ISO 8601 timestamp of the upload. */
  uploadedAt: string;
}

/**
 * Serializes every read-modify-write of history.json. Without this, concurrent
 * recordUpload/removeFromHistory calls (handleScreenshot, the queue drain loop
 * and the dashboard delete handler all run in the one daemon process) read the
 * same snapshot and last-writer-wins loses or resurrects entries.
 */
let historyLock: Promise<unknown> = Promise.resolve();

const withHistoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = historyLock.then(fn, fn);
  historyLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/**
 * Record a successful upload at the head of the history file (newest first),
 * capped at {@link MAX_ENTRIES}. Never throws (best-effort, like state.ts).
 */
export const recordUpload = async (entry: HistoryEntry): Promise<void> => {
  try {
    await withHistoryLock(async () => {
      const entries = await readHistory();
      entries.unshift(entry);
      await writeHistory(entries.slice(0, MAX_ENTRIES));
    });
  } catch (err) {
    console.error(`spootie: could not record upload history: ${errorMessage(err)}`);
  }
};

/** Read the history file (newest first). Returns [] if missing or corrupt. */
export const readHistory = async (): Promise<HistoryEntry[]> => {
  try {
    const raw: unknown = await Bun.file(HISTORY_PATH).json();
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is HistoryEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { key?: unknown }).key === "string" &&
        typeof (item as { url?: unknown }).url === "string" &&
        typeof (item as { fileName?: unknown }).fileName === "string" &&
        typeof (item as { uploadedAt?: unknown }).uploadedAt === "string",
    );
  } catch {
    return [];
  }
};

/**
 * Remove the history entry with the given key. Returns true if an entry was
 * removed. Never throws (best-effort).
 */
export const removeFromHistory = async (key: string): Promise<boolean> => {
  try {
    return await withHistoryLock(async () => {
      const entries = await readHistory();
      const kept = entries.filter((e) => e.key !== key);
      if (kept.length === entries.length) return false;
      await writeHistory(kept);
      return true;
    });
  } catch (err) {
    console.error(`spootie: could not update upload history: ${errorMessage(err)}`);
    return false;
  }
};

/** The most recent successful upload, or null if there are none. */
export const readLastUpload = async (): Promise<HistoryEntry | null> => {
  const entries = await readHistory();
  return entries[0] ?? null;
};

/**
 * One-time migration of the pre-history last-upload.json ({ url, uploadedAt })
 * into history.json, then removes the old file. No-op (and just drops the stale
 * file) once history.json exists. Best-effort — never throws — so it can run
 * before every command without ever blocking one.
 */
export const migrateLastUpload = async (): Promise<void> => {
  try {
    if (await Bun.file(HISTORY_PATH).exists()) {
      await unlink(LAST_UPLOAD_PATH).catch(() => {});
      return;
    }
    const raw: unknown = await Bun.file(LAST_UPLOAD_PATH).json();
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { url?: unknown }).url === "string" &&
      typeof (raw as { uploadedAt?: unknown }).uploadedAt === "string"
    ) {
      const { url, uploadedAt } = raw as { url: string; uploadedAt: string };
      // The legacy record lacks a key/fileName; reconstruct both from the URL
      // so `spootie last` still shows it and delete can target the R2 object.
      let key = url;
      try {
        key = new URL(url).pathname.replace(/^\/+/, "");
      } catch {
        // Not a URL we can parse; fall back to the raw string.
      }
      const fileName = key.split("/").pop() || key;
      await writeHistory([{ key, url, fileName, uploadedAt }]);
    }
    await unlink(LAST_UPLOAD_PATH).catch(() => {});
  } catch {
    // Missing or corrupt last-upload.json: nothing to migrate.
  }
};

/**
 * Atomically persist the history file. Callers hold {@link withHistoryLock}, so
 * writes are serialized and a fixed temp path is safe — it can't collide, and
 * it self-heals by being overwritten on the next write if a crash strands it
 * (a per-write unique name would instead orphan a file on every crash).
 */
const writeHistory = async (entries: HistoryEntry[]): Promise<void> => {
  await ensurePrivateDir(dirname(HISTORY_PATH));
  const tempPath = `${HISTORY_PATH}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, HISTORY_PATH);
};
