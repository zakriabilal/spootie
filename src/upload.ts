import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import type { Config } from "./config.ts";

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
 * Delete an object from R2 by its key, using the same signing/client approach
 * as {@link uploadFile}.
 */
export const deleteObject = async (key: string, config: Config): Promise<void> => {
    const client = makeClient(config);
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
};
