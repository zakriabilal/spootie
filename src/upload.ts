import {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import type { Config } from "./config.ts";
import { errorMessage } from "./errors.ts";

const CONTENT_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".tiff": "image/tiff",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
};

/** Generate a long, unguessable, URL-safe object key preserving the extension. */
export const generateKey = (filePath: string): string => {
    // 18 bytes -> 24 URL-safe base64 chars, comfortably over the 16-char floor.
    const random = randomBytes(18).toString("base64url");
    const ext = extname(filePath).toLowerCase();
    return `${random}${ext}`;
};

const contentTypeFor = (filePath: string): string => {
    const ext = extname(filePath).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
};

export const makeClient = (config: Config): S3Client =>
    new S3Client({
        region: "auto",
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
        // R2 does not support the AWS SDK's default flexible checksums
        // (x-amz-checksum-*); without these settings uploads are rejected.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
    });

/**
 * Upload a local file to R2. Returns the public share URL and the object key.
 */
export const uploadFile = async (
    filePath: string,
    config: Config,
): Promise<{ url: string; key: string }> => {
    const key = generateKey(filePath);
    const body = new Uint8Array(await Bun.file(filePath).arrayBuffer());

    const client = makeClient(config);
    await client.send(
        new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentTypeFor(filePath),
        }),
    );

    return { url: `${config.publicBaseUrl}/${key}`, key };
};

/**
 * Upload raw bytes to R2 under a caller-chosen key, with an explicit content
 * type and Content-Disposition. Used by the dashboard drop zone, which has the
 * bytes in memory (from a multipart upload) rather than a file on disk, and
 * wants recipients to download the object under its original name. Returns the
 * public share URL and the key it was stored under.
 */
export const uploadBytes = async (
    body: Uint8Array,
    key: string,
    contentType: string,
    contentDisposition: string,
    config: Config,
): Promise<{ url: string; key: string }> => {
    const client = makeClient(config);
    await client.send(
        new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ContentDisposition: contentDisposition,
        }),
    );

    return { url: `${config.publicBaseUrl}/${key}`, key };
};

/**
 * Percent-encode a string as an RFC 5987 ext-value (the `filename*` form). Only
 * the RFC 5987 attr-char set is left unescaped: `encodeURIComponent` already
 * encodes everything outside `A-Za-z0-9-_.!~*'()`, and we additionally encode
 * `* ' ( )` — which are not attr-chars — leaving only attr-chars unescaped.
 */
const encodeRFC5987 = (value: string): string =>
    encodeURIComponent(value).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

/**
 * Build a `Content-Disposition: attachment` header that makes a recipient's
 * browser download the object under its original file name (RFC 6266). The name
 * is reduced to its basename (any path separators dropped) and control
 * characters are stripped, so it can neither imply a path on the recipient nor
 * inject header bytes. Emits both:
 *
 *  - `filename="…"`  — an ASCII-only fallback for legacy clients, with every
 *    non-printable-ASCII byte and the quote/backslash that would break the
 *    quoted-string replaced by `_`.
 *  - `filename*=UTF-8''…` — the exact original name, percent-encoded per RFC
 *    5987, which modern clients prefer.
 */
export const contentDispositionAttachment = (fileName: string): string => {
    // Drop any path components a hostile name might carry, keep the basename.
    const base = fileName.split(/[/\\]/).pop() ?? fileName;
    // Strip C0 control chars (incl. CR/LF, which could split the header) + DEL.
    // Done by code point rather than a control-char regex (which oxlint bans).
    const clean = [...base]
        .filter((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code > 0x1f && code !== 0x7f;
        })
        .join("");
    const safe = clean.length > 0 ? clean : "download";
    // ASCII fallback: non-printable-ASCII -> "_", then quote/backslash -> "_".
    const ascii = safe.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(safe)}`;
};

/**
 * Delete an object from R2 by its key, using the same signing/client approach
 * as {@link uploadFile}.
 */
export const deleteObject = async (key: string, config: Config): Promise<void> => {
    const client = makeClient(config);
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
};

/** The most keys a single S3 DeleteObjects request accepts. */
const DELETE_OBJECTS_LIMIT = 1000;

/**
 * Delete many objects from R2 with the batched DeleteObjects API rather than N
 * sequential DeleteObject calls. Keys are chunked into requests of at most
 * {@link DELETE_OBJECTS_LIMIT} and sent in Quiet mode — the response then omits
 * the successfully-deleted keys and returns only per-key {@link errorMessage}s,
 * so we infer success as "in the chunk and not reported as an error".
 *
 * Reports honestly per key: `deleted` lists the keys R2 confirmed gone, `failed`
 * pairs each remaining key with its error. A whole request that throws (network
 * down, auth error) marks every key in that chunk as failed with the thrown
 * message, so the caller can keep those items around for a later retry.
 */
export const deleteObjects = async (
    keys: string[],
    config: Config,
): Promise<{ deleted: string[]; failed: { key: string; error: string }[] }> => {
    const client = makeClient(config);
    const deleted: string[] = [];
    const failed: { key: string; error: string }[] = [];

    for (let i = 0; i < keys.length; i += DELETE_OBJECTS_LIMIT) {
        const chunk = keys.slice(i, i + DELETE_OBJECTS_LIMIT);
        try {
            const res = await client.send(
                new DeleteObjectsCommand({
                    Bucket: config.bucket,
                    Delete: {
                        Objects: chunk.map((Key) => ({ Key })),
                        // Quiet: response carries only errors, not the (many) OKs.
                        Quiet: true,
                    },
                }),
            );
            const failedKeys = new Set<string>();
            for (const e of res.Errors ?? []) {
                if (typeof e.Key === "string") {
                    failedKeys.add(e.Key);
                    failed.push({ key: e.Key, error: e.Message ?? e.Code ?? "Delete failed" });
                }
            }
            for (const key of chunk) {
                if (!failedKeys.has(key)) deleted.push(key);
            }
        } catch (err) {
            // The whole request failed: treat every key in this chunk as failed so
            // the caller retains them (in history) for a retry rather than dropping
            // records for objects that may still exist.
            const message = errorMessage(err);
            for (const key of chunk) failed.push({ key, error: message });
        }
    }

    return { deleted, failed };
};
