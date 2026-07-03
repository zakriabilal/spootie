import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
};

/** Generate a long, unguessable, URL-safe object key preserving the extension. */
export function generateKey(filePath: string): string {
  // 18 bytes -> 24 URL-safe base64 chars, comfortably over the 16-char floor.
  const random = randomBytes(18).toString("base64url");
  const ext = extname(filePath).toLowerCase();
  return `${random}${ext}`;
}

function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function makeClient(config: Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Upload a local file to R2 and return its public share URL.
 */
export async function uploadFile(
  filePath: string,
  config: Config,
): Promise<string> {
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

  return `${config.publicBaseUrl}/${key}`;
}
