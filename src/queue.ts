import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { errorMessage, isRetryableNetworkError } from "./errors.ts";
import { copyToClipboard } from "./clipboard.ts";
import { notify, notifyError, offerCopyUrl } from "./notify.ts";
import { DATA_DIR, recordLastUpload } from "./state.ts";
import { uploadFile } from "./upload.ts";

export const QUEUE_PATH = join(DATA_DIR, "queue.json");

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

interface QueueEntry {
  filePath: string;
  queuedAt: string;
}

/**
 * Persistent FIFO queue of uploads that failed with a network error. While
 * the daemon runs, a single in-process drain loop retries the head entry with
 * exponential backoff (5s doubling to 60s, reset on success). The queue file
 * survives restarts; `start()` resumes any pending entries.
 */
export class UploadQueue {
  private entries: QueueEntry[] = [];
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;

  constructor(private readonly config: Config) {}

  /** Load persisted entries and resume draining them. */
  async start(): Promise<void> {
    this.entries = await loadEntries();
    if (this.entries.length > 0) {
      console.log(
        `spootie: ${this.entries.length} queued upload(s) from a previous run; retrying`,
      );
      this.scheduleDrain(0);
    }
  }

  /** Queue a file for retry and notify the user it is queued. */
  async enqueue(filePath: string): Promise<void> {
    this.entries.push({ filePath, queuedAt: new Date().toISOString() });
    await this.persist();
    console.log(`spootie: queued ${basename(filePath)} for retry`);
    notify(basename(filePath), "Offline — upload queued");
    this.scheduleDrain(this.backoffMs);
  }

  private scheduleDrain(delayMs: number): void {
    // An existing timer (or running drain, which re-schedules as needed)
    // already covers pending entries.
    if (this.timer !== null || this.draining) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Catch anything that escapes drain() (e.g. a failed persist write) so
      // it logs instead of becoming an unhandled rejection.
      this.drain().catch((err: unknown) => {
        console.error(`spootie: queue drain failed: ${errorMessage(err)}`);
      });
    }, delayMs);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.entries.length > 0) {
        const entry = this.entries[0]!;
        const name = basename(entry.filePath);

        if (!(await Bun.file(entry.filePath).exists())) {
          console.log(`spootie: dropping queued upload, file is gone: ${entry.filePath}`);
          await this.removeHead();
          continue;
        }

        try {
          const { url } = await uploadFile(entry.filePath, this.config);
          await this.removeHead();
          this.backoffMs = INITIAL_BACKOFF_MS;
          console.log(`Uploaded queued ${name} -> ${url}`);
          await recordLastUpload(url);
          // Don't block the drain on the user's response; and never write
          // the clipboard unprompted for late completions.
          void this.offerCopy(url);
        } catch (err) {
          if (isRetryableNetworkError(err)) {
            console.error(
              `spootie: retry failed for ${name} (${errorMessage(err)}); ` +
                `next attempt in ${Math.round(this.backoffMs / 1000)}s`,
            );
            const delay = this.backoffMs;
            this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
            this.draining = false;
            this.scheduleDrain(delay);
            return;
          }
          // Permanent failure: notify and drop so it cannot loop forever.
          console.error(`spootie: dropping queued upload for ${name}: ${errorMessage(err)}`);
          notifyError(`Upload failed for ${name}`);
          await this.removeHead();
        }
      }
    } finally {
      this.draining = false;
      // An enqueue may have raced with the loop exiting; make sure anything
      // still pending has a scheduled attempt.
      if (this.entries.length > 0) this.scheduleDrain(this.backoffMs);
    }
  }

  private async offerCopy(url: string): Promise<void> {
    try {
      if (await offerCopyUrl(url)) {
        await copyToClipboard(url);
        notify(url, "URL copied");
      }
    } catch (err) {
      console.error(`spootie: copy offer failed: ${errorMessage(err)}`);
    }
  }

  private async removeHead(): Promise<void> {
    this.entries.shift();
    await this.persist();
  }

  /** Atomically persist the queue (temp file + rename). */
  private async persist(): Promise<void> {
    await mkdir(dirname(QUEUE_PATH), { recursive: true });
    const tempPath = `${QUEUE_PATH}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.entries, null, 2)}\n`);
    await rename(tempPath, QUEUE_PATH);
  }
}

/** Number of pending queued uploads (reads the queue file; used by status). */
export async function readQueueLength(): Promise<number> {
  return (await loadEntries()).length;
}

async function loadEntries(): Promise<QueueEntry[]> {
  try {
    const raw: unknown = await Bun.file(QUEUE_PATH).json();
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (item): item is QueueEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { filePath?: unknown }).filePath === "string" &&
        typeof (item as { queuedAt?: unknown }).queuedAt === "string",
    );
  } catch {
    // Missing or corrupt queue file: start fresh.
    return [];
  }
}
