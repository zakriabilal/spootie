import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { errorMessage } from "../lib/errors.ts";
import { createJsonLoader, createJsonWriter } from "../lib/persist.ts";
import { DATA_DIR } from "../lib/state.ts";
import { deleteThumbnail, renderThumbnail } from "./thumbs.ts";

export const PENDING_PATH = join(DATA_DIR, "pending.json");

export interface PendingEntry {
    /** Stable id, used by the UI to approve/discard a specific screenshot. */
    id: string;
    filePath: string;
    fileName: string;
    /** ISO 8601 timestamp of when the screenshot was detected. */
    detectedAt: string;
    /** True once a local thumbnail has been generated for this entry. */
    thumb: boolean;
}

/**
 * Persistent list of detected screenshots awaiting the user's approve/discard
 * decision. Unlike UploadQueue, entries here never expire or retry on their
 * own — they simply sit until the dashboard acts on them, surviving daemon
 * restarts. Persistence mirrors queue.ts: serialized atomic writes, private
 * dir, load-on-start.
 */
export class PendingStore {
    private entries: PendingEntry[] = [];
    /**
     * Atomically persist pending.json, serialized so an out-of-order
     * write/rename can't resurrect a stale entry. See {@link createJsonWriter}.
     */
    private readonly persist = createJsonWriter<PendingEntry[]>(PENDING_PATH);

    /** Load persisted entries, tolerating a missing or corrupt file. */
    async start(): Promise<void> {
        this.entries = await loadEntries();
    }

    /**
     * Record a freshly detected screenshot and kick off a local thumbnail in
     * the background. Never throws.
     */
    async add(filePath: string): Promise<void> {
        const entry: PendingEntry = {
            id: randomUUID(),
            filePath,
            fileName: basename(filePath),
            detectedAt: new Date().toISOString(),
            thumb: false,
        };
        this.entries.push(entry);
        await this.persist(this.entries);

        void renderThumbnail(entry.id, filePath)
            .then(async (ok) => {
                if (!ok) return;
                // The entry may have been discarded while the thumbnail rendered;
                // if so, drop the file we just wrote so it doesn't linger orphaned.
                const current = this.entries.find((e) => e.id === entry.id);
                if (current === undefined) {
                    await deleteThumbnail(entry.id);
                    return;
                }
                current.thumb = true;
                await this.persist(this.entries);
            })
            .catch((err: unknown) => {
                console.error(
                    `spootie: thumbnail generation failed for ${entry.fileName}: ${errorMessage(err)}`,
                );
            });
    }

    /** A snapshot of the pending entries (used by the UI server). */
    list(): PendingEntry[] {
        return [...this.entries];
    }

    get(id: string): PendingEntry | undefined {
        return this.entries.find((e) => e.id === id);
    }

    /**
     * Remove a pending entry by id, persist, and best-effort drop its local
     * thumbnail. Returns true if an entry was found and removed.
     */
    async discard(id: string): Promise<boolean> {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => e.id !== id);
        if (this.entries.length === before) return false;
        await this.persist(this.entries);
        await deleteThumbnail(id);
        return true;
    }
}

const loadEntries = createJsonLoader<PendingEntry>(PENDING_PATH, (item) => {
    if (typeof item !== "object" || item === null) return null;
    const { filePath, detectedAt, id, fileName, thumb } = item as {
        filePath?: unknown;
        detectedAt?: unknown;
        id?: unknown;
        fileName?: unknown;
        thumb?: unknown;
    };
    if (typeof filePath !== "string" || typeof detectedAt !== "string") return null;
    // Backfill an id/fileName/thumb for entries persisted before they existed.
    return {
        id: typeof id === "string" ? id : randomUUID(),
        filePath,
        fileName: typeof fileName === "string" ? fileName : basename(filePath),
        detectedAt,
        thumb: thumb === true,
    };
});
