import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./state.ts";

/**
 * Build a serialized atomic writer for a JSON state file, shared by UploadQueue
 * and PendingStore.
 *
 * Each call queues behind the previous one so out-of-order writeFile/rename
 * pairs can't let a stale snapshot win the rename — without this, an HTTP
 * mutation racing a background task could resurrect a just-removed entry: a
 * slower earlier write finishing after a later rename would leave the file
 * describing the earlier state while memory holds the later one. Each queued
 * write persists the caller's latest snapshot, and the last-queued write lands
 * last.
 *
 * A failed write is swallowed into the internal chain so one bad write can't
 * wedge later writes, but its rejection still surfaces to that write's caller.
 * The file is written 0600 via a temp file + rename so a reader never sees a
 * half-written file.
 */
export const createJsonWriter = <T>(path: string): ((data: T) => Promise<void>) => {
    let lock: Promise<unknown> = Promise.resolve();

    const write = async (data: T): Promise<void> => {
        await ensurePrivateDir(dirname(path));
        const tempPath = `${path}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        await rename(tempPath, path);
    };

    return (data: T): Promise<void> => {
        const run = lock.then(
            () => write(data),
            () => write(data),
        );
        lock = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    };
};

/**
 * Build a loader for a JSON array state file, the read-side companion to
 * {@link createJsonWriter}. Reads the file, tolerates a missing or corrupt one
 * by returning `[]`, and normalizes each element through `parse` — which returns
 * the cleaned entry, or null to drop a malformed one (used to backfill fields
 * added after the file was first written). Shared by UploadQueue and
 * PendingStore.
 */
export const createJsonLoader =
    <T>(path: string, parse: (item: unknown) => T | null): (() => Promise<T[]>) =>
    async (): Promise<T[]> => {
        try {
            const raw: unknown = await Bun.file(path).json();
            if (!Array.isArray(raw)) return [];
            return raw.map(parse).filter((entry): entry is T => entry !== null);
        } catch {
            // Missing or corrupt file: start fresh.
            return [];
        }
    };
