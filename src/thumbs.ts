/**
 * Local thumbnails for uploaded images.
 *
 * Thumbnails are generated with macOS's built-in `sips` and kept ONLY on this
 * machine, under the private state dir — they are never uploaded to R2 (objects
 * there are public and expire). The dashboard serves them over the loopback UI
 * server (see server.ts) so uploaded images get a small preview.
 *
 * Every failure is swallowed: a missing `sips` (e.g. on the Linux dev box, where
 * Bun.spawn throws synchronously with ENOENT), a non-zero exit, or a timeout all
 * result in a single logged line and no thumbnail — never a crash, never an
 * unhandled rejection, and never any effect on the upload result.
 */
import { chmod, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { errorMessage } from "./errors.ts";
import { markThumbGenerated } from "./history.ts";
import { DATA_DIR, ensurePrivateDir } from "./state.ts";

/** Where thumbnails live: a private (0700) subdir of the shared state dir. */
export const THUMBS_DIR = join(DATA_DIR, "thumbs");

/** Longest edge of the generated thumbnail, in pixels (aspect preserved). */
const MAX_DIMENSION = 320;

/** JPEG quality passed to `sips -s formatOptions` (0–100). */
const JPEG_QUALITY = 80;

/** Kill sips if it hangs, so a stuck process can never wedge a thumbnail. */
const SIPS_TIMEOUT_MS = 15_000;

/**
 * Extensions we attempt a thumbnail for. Everything else (pdf, txt, …) simply
 * gets no thumbnail — the dashboard shows a neutral placeholder instead.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".tiff", ".gif"]);

/**
 * The only characters an R2 object key can contain (it is randomBytes base64url
 * plus a lowercase extension — see upload.ts generateKey). The thumb-serving
 * route and the on-disk path both derive from a key, so we never trust one that
 * strays outside this set.
 */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Validate an R2 object key for use in a filesystem path. Rejects anything with
 * a path separator, a parent-dir reference, or any character outside
 * {@link SAFE_KEY} — so a hostile `key` can never escape {@link THUMBS_DIR}.
 * Returns the key unchanged if safe, otherwise null.
 */
export const sanitizeThumbKey = (key: string): string | null => {
    if (typeof key !== "string" || key.length === 0) return null;
    // `..` is composed of otherwise-allowed characters, so reject it explicitly.
    if (key.includes("/") || key.includes("\\") || key.includes("..")) return null;
    if (!SAFE_KEY.test(key)) return null;
    return key;
};

/**
 * Resolve the on-disk thumbnail path for an object key, or null if the key is
 * unsafe. Defence in depth: after sanitizing, the resolved path is confirmed to
 * sit strictly inside {@link THUMBS_DIR} before it is returned.
 */
export const thumbPathForKey = (key: string): string | null => {
    const safe = sanitizeThumbKey(key);
    if (safe === null) return null;
    const base = resolve(THUMBS_DIR);
    const path = resolve(join(THUMBS_DIR, `${safe}.jpg`));
    if (path !== base && !path.startsWith(`${base}${sep}`)) return null;
    return path;
};

/**
 * Fire-and-forget thumbnail generation for a freshly uploaded file. Safe to call
 * without awaiting: it starts the work, marks the history entry on success, and
 * absorbs every error (including a synchronous Bun.spawn throw when sips is
 * absent) so it can never surface as an unhandled rejection or block the caller.
 */
export const generateThumbnail = (key: string, sourcePath: string): void => {
    void createThumbnail(key, sourcePath).catch((err: unknown) => {
        console.error(`spootie: thumbnail generation failed for ${key}: ${errorMessage(err)}`);
    });
};

/**
 * Fire-and-forget thumbnail generation for freshly-uploaded bytes that have no
 * source file on disk (the dashboard drop zone holds the file in memory). Writes
 * the bytes to a private temp file inside {@link THUMBS_DIR} carrying the object
 * key (so its extension drives {@link createThumbnail}'s image-type check and
 * sips reads a real path), runs the thumbnail, then always removes the temp
 * file. Like {@link generateThumbnail} it absorbs every error, so it can never
 * surface as an unhandled rejection — and the `finally` guarantees the temp file
 * is cleaned up on every path, including a thrown createThumbnail.
 */
export const generateThumbnailFromBytes = (
    key: string,
    fileName: string,
    bytes: Uint8Array,
): void => {
    void thumbnailFromBytes(key, fileName, bytes).catch((err: unknown) => {
        console.error(`spootie: thumbnail generation failed for ${key}: ${errorMessage(err)}`);
    });
};

const thumbnailFromBytes = async (
    key: string,
    fileName: string,
    bytes: Uint8Array,
): Promise<void> => {
    // Skip non-images up front so we never write a temp file we can't use. The
    // key carries the same (lowercased) extension as the original name.
    if (!IMAGE_EXTENSIONS.has(extname(fileName).toLowerCase())) return;

    await ensurePrivateDir(THUMBS_DIR);
    // A private, unique temp path alongside the thumbnails. It is never served:
    // serveThumb only ever hands out `<key>.jpg` files, and this is `.<key>`.
    const tempPath = join(THUMBS_DIR, `.incoming-${key}`);
    try {
        await writeFile(tempPath, bytes, { mode: 0o600 });
        await createThumbnail(key, tempPath);
    } finally {
        await unlink(tempPath).catch(() => {});
    }
};

export const createThumbnail = async (key: string, sourcePath: string): Promise<void> => {
    if (!IMAGE_EXTENSIONS.has(extname(sourcePath).toLowerCase())) return;

    const thumbPath = thumbPathForKey(key);
    // Our own keys are always safe; this only fails on a corrupt history entry.
    if (thumbPath === null) return;

    await ensurePrivateDir(THUMBS_DIR);

    // Factory so `proc` keeps its precise inferred type (stderr as a
    // ReadableStream) instead of the widened generic Bun.spawn return type.
    // sips -Z <n>            : resample so the longest edge is n px (aspect kept)
    // -s format jpeg         : output JPEG
    // -s formatOptions <q>   : JPEG quality (0–100)
    // --out <path>           : write the result here (never touches the source)
    const spawnSips = () =>
        Bun.spawn(
            [
                "sips",
                "-Z",
                String(MAX_DIMENSION),
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                String(JPEG_QUALITY),
                sourcePath,
                "--out",
                thumbPath,
            ],
            { stdout: "ignore", stderr: "pipe" },
        );

    let proc: ReturnType<typeof spawnSips>;
    try {
        proc = spawnSips();
    } catch (err) {
        // sips missing (e.g. the Linux dev box): Bun.spawn throws synchronously.
        console.error(`spootie: could not run sips for ${key}: ${errorMessage(err)}`);
        return;
    }

    const timeout = setTimeout(() => proc.kill(), SIPS_TIMEOUT_MS);
    let code: number;
    try {
        code = await proc.exited;
    } finally {
        clearTimeout(timeout);
    }

    if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.error(`spootie: sips thumbnail failed for ${key} (exit ${code}): ${stderr.trim()}`);
        return;
    }

    // Keep the preview private like the rest of state (sips uses the umask).
    await chmod(thumbPath, 0o600).catch(() => {});
    await markThumbGenerated(key);
};

/**
 * Best-effort delete of an item's thumbnail (called when the upload is deleted).
 * Never throws: an unsafe key or a missing file is silently ignored.
 */
export const deleteThumbnail = async (key: string): Promise<void> => {
    const thumbPath = thumbPathForKey(key);
    if (thumbPath === null) return;
    await unlink(thumbPath).catch(() => {});
};
