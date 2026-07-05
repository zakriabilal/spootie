import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Config } from "../lib/config.ts";
import { errorMessage, isRetryableNetworkError } from "../lib/errors.ts";
import { recordUpload } from "../lib/history.ts";
import { notify, notifyError } from "../lib/notify.ts";
import { createJsonLoader, createJsonWriter } from "../lib/persist.ts";
import { DATA_DIR } from "../lib/state.ts";
import { generateThumbnail } from "./thumbs.ts";
import { deleteObject, uploadFile } from "../lib/upload.ts";

export const QUEUE_PATH = join(DATA_DIR, "queue.json");

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export interface QueueEntry {
    /** Stable id, used by the UI to cancel a specific queued upload. */
    id: string;
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
    /**
     * Atomically persist the queue, serialized so out-of-order writeFile/rename
     * pairs can't let a stale snapshot win the rename — an HTTP cancel racing the
     * drain loop's removeEntry could otherwise resurrect a removed entry. See
     * {@link createJsonWriter}.
     */
    private readonly persist = createJsonWriter<QueueEntry[]>(QUEUE_PATH);

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
        this.entries.push({
            id: randomUUID(),
            filePath,
            queuedAt: new Date().toISOString(),
        });
        await this.persist(this.entries);
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
                    await this.removeEntry(entry);
                    continue;
                }

                try {
                    const { url, key } = await uploadFile(entry.filePath, this.config);
                    // cancel() may have removed this entry while the upload was in
                    // flight; if so, honour the cancellation instead of recording it.
                    const cancelledInFlight = !this.entries.includes(entry);
                    await this.removeEntry(entry);
                    this.backoffMs = INITIAL_BACKOFF_MS;
                    if (cancelledInFlight) {
                        console.log(`spootie: ${name} was cancelled mid-upload; deleting from R2`);
                        await deleteObject(key, this.config).catch((err: unknown) => {
                            console.error(
                                `spootie: could not delete cancelled upload ${name}: ${errorMessage(err)}`,
                            );
                        });
                        continue;
                    }
                    console.log(`Uploaded queued ${name} -> ${url}`);
                    await recordUpload({
                        key,
                        url,
                        fileName: name,
                        uploadedAt: new Date().toISOString(),
                    });
                    // Local-only preview; fire-and-forget so it never delays the drain.
                    generateThumbnail(key, entry.filePath);
                    notify(name, "Uploaded — copy the link from the dashboard");
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
                    console.error(
                        `spootie: dropping queued upload for ${name}: ${errorMessage(err)}`,
                    );
                    notifyError(`Upload failed for ${name}`);
                    await this.removeEntry(entry);
                }
            }
        } finally {
            this.draining = false;
            // An enqueue may have raced with the loop exiting; make sure anything
            // still pending has a scheduled attempt.
            if (this.entries.length > 0) this.scheduleDrain(this.backoffMs);
        }
    }

    /** Remove a specific entry by reference (safe against reordering) and persist. */
    private async removeEntry(entry: QueueEntry): Promise<void> {
        this.entries = this.entries.filter((e) => e !== entry);
        await this.persist(this.entries);
    }

    /** A snapshot of the pending queued entries (used by the UI server). */
    list(): QueueEntry[] {
        return [...this.entries];
    }

    /**
     * Cancel a pending queued upload by id. Returns true if an entry was found
     * and removed. Persists the change to queue.json.
     */
    async cancel(id: string): Promise<boolean> {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => e.id !== id);
        if (this.entries.length === before) return false;
        await this.persist(this.entries);
        return true;
    }
}

/** Number of pending queued uploads (reads the queue file; used by status). */
export const readQueueLength = async (): Promise<number> => (await loadEntries()).length;

const loadEntries = createJsonLoader<QueueEntry>(QUEUE_PATH, (item) => {
    if (typeof item !== "object" || item === null) return null;
    const { filePath, queuedAt, id } = item as {
        filePath?: unknown;
        queuedAt?: unknown;
        id?: unknown;
    };
    if (typeof filePath !== "string" || typeof queuedAt !== "string") return null;
    // Backfill an id for entries persisted before ids existed.
    return { id: typeof id === "string" ? id : randomUUID(), filePath, queuedAt };
});
