import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Data directory shared by the queue, pause flag and last-upload record. */
export const DATA_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "spootie",
);

export const PAUSE_PATH = join(DATA_DIR, "paused");
const LAST_UPLOAD_PATH = join(DATA_DIR, "last-upload.json");

// --- pause flag (cross-process: CLI writes it, the daemon polls it) ----------

export function isPaused(): Promise<boolean> {
  return Bun.file(PAUSE_PATH).exists();
}

export async function setPaused(paused: boolean): Promise<void> {
  if (paused) {
    await mkdir(DATA_DIR, { recursive: true });
    await Bun.write(PAUSE_PATH, "");
  } else {
    await unlink(PAUSE_PATH).catch(() => {});
  }
}

// --- last successful upload ---------------------------------------------------

export interface LastUpload {
  url: string;
  uploadedAt: string;
}

/** Record the most recent successful upload. Never throws (best-effort). */
export async function recordLastUpload(url: string): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const record: LastUpload = { url, uploadedAt: new Date().toISOString() };
    await Bun.write(LAST_UPLOAD_PATH, `${JSON.stringify(record, null, 2)}\n`);
  } catch (err) {
    console.error(
      `spootie: could not record last upload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function readLastUpload(): Promise<LastUpload | null> {
  try {
    const raw: unknown = await Bun.file(LAST_UPLOAD_PATH).json();
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { url?: unknown }).url === "string" &&
      typeof (raw as { uploadedAt?: unknown }).uploadedAt === "string"
    ) {
      return raw as LastUpload;
    }
    return null;
  } catch {
    return null;
  }
}
