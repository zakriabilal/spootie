import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
} from "@aws-sdk/client-s3";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_PATH,
  readExistingConfig,
  saveConfig,
  type Config,
} from "./config.ts";
import {
  errorMessage,
  errorName,
  isAccessDenied,
  isBadCredentials,
  isNoLifecycleConfiguration,
} from "./errors.ts";
import { makeClient, uploadFile } from "./upload.ts";

const LIFECYCLE_RULE_ID = "spootie-expiry";

/**
 * Interactive setup wizard: prompt for R2 settings, write the config file,
 * apply the object-expiry lifecycle rule, and verify public access with a
 * round-trip test upload.
 */
export async function runSetup(): Promise<void> {
  console.log("spootie setup");
  console.log("Prompts show the current value in [brackets]; press Enter to keep it.\n");

  const existing = (await readExistingConfig()) ?? {};
  if (Object.keys(existing).length > 0) {
    console.log(`Found existing config at ${CONFIG_PATH}; editing it.\n`);
  }

  const config = await promptForConfig(existing);

  await saveConfig(config);
  console.log(`\n✓ Config saved to ${CONFIG_PATH}`);

  const client = makeClient(config);

  await applyLifecycleStep(client, config);
  await verifyUploadStep(client, config);

  console.log("\nSetup complete. Run `spootie watch` to start uploading screenshots.");
}

// --- prompts ---------------------------------------------------------------

// Bun's global prompt() returns null for an empty line, which makes
// "press Enter to keep the current value" impossible. Read stdin lines via
// the console async iterator instead: "" is an empty line, null is EOF.
const stdinLines = console[Symbol.asyncIterator]();

async function askLine(question: string): Promise<string | null> {
  process.stdout.write(question);
  const { value, done } = await stdinLines.next();
  return done ? null : (value as string);
}

async function promptForConfig(existing: Record<string, unknown>): Promise<Config> {
  const current = (key: string): string | undefined => {
    const value = existing[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };

  const accountId = await promptText("accountId (Cloudflare account ID)", current("accountId"));
  const accessKeyId = await promptText("accessKeyId (R2 S3 API token key ID)", current("accessKeyId"));
  const secretAccessKey = await promptText(
    "secretAccessKey (R2 S3 API token secret)",
    current("secretAccessKey"),
    { mask: true },
  );
  const bucket = await promptText("bucket (R2 bucket name)", current("bucket"));
  const publicBaseUrl = (
    await promptText("publicBaseUrl (e.g. https://pub-xxxx.r2.dev)", current("publicBaseUrl"))
  ).replace(/\/+$/, "");

  const currentExpiry =
    typeof existing.expiryDays === "number" && existing.expiryDays > 0
      ? existing.expiryDays
      : 7;
  const expiryDays = await promptExpiryDays(currentExpiry);

  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl, expiryDays };
}

async function promptText(
  label: string,
  currentValue?: string,
  opts: { mask?: boolean } = {},
): Promise<string> {
  const shown =
    currentValue === undefined
      ? undefined
      : opts.mask
        ? maskSecret(currentValue)
        : currentValue;
  const suffix = shown === undefined ? "" : ` [${shown}]`;

  for (;;) {
    const input = await askLine(`${label}${suffix}: `);
    if (input === null) abortSetup();
    const trimmed = input.trim();
    if (trimmed !== "") return trimmed;
    if (currentValue !== undefined) return currentValue;
    console.log("A value is required.");
  }
}

async function promptExpiryDays(currentValue: number): Promise<number> {
  for (;;) {
    const input = await askLine(
      `expiryDays (uploads auto-delete after this many days) [${currentValue}]: `,
    );
    if (input === null) abortSetup();
    const trimmed = input.trim();
    if (trimmed === "") return currentValue;
    const value = Number(trimmed);
    if (Number.isInteger(value) && value > 0) return value;
    console.log("Enter a positive whole number of days.");
  }
}

function maskSecret(value: string): string {
  return value.length > 4 ? `****${value.slice(-4)}` : "****";
}

function abortSetup(): never {
  console.error("\nSetup aborted (no input).");
  process.exit(1);
}

// --- lifecycle rule ---------------------------------------------------------

async function applyLifecycleStep(client: S3Client, config: Config): Promise<void> {
  try {
    await applyLifecycleRule(client, config);
    console.log(`✓ Lifecycle rule applied (objects expire after ${config.expiryDays} days)`);
  } catch (err) {
    if (isBadCredentials(err)) failBadCredentials(err);
    if (isAccessDenied(err)) {
      console.warn(
        "! Could not set the lifecycle rule: the API token lacks bucket-level permission.\n" +
          "  Uploads will still work, but old screenshots will NOT auto-expire.\n" +
          '  To fix: create an R2 API token with "Admin Read & Write" and re-run `spootie setup`.',
      );
      return;
    }
    console.warn(`! Could not set the lifecycle rule: ${errorMessage(err)}`);
    console.warn("  Uploads will still work, but old screenshots will NOT auto-expire.");
  }
}

async function applyLifecycleRule(client: S3Client, config: Config): Promise<void> {
  // PutBucketLifecycleConfiguration replaces the whole configuration, so
  // preserve any rules the user set outside spootie.
  let rules: LifecycleRule[] = [];
  try {
    const current = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }),
    );
    rules = current.Rules ?? [];
  } catch (err) {
    if (!isNoLifecycleConfiguration(err)) throw err;
  }

  const spootieRule: LifecycleRule = {
    ID: LIFECYCLE_RULE_ID,
    Status: "Enabled",
    Filter: { Prefix: "" }, // whole bucket
    Expiration: { Days: config.expiryDays },
  };

  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: config.bucket,
      LifecycleConfiguration: {
        Rules: [...rules.filter((rule) => rule.ID !== LIFECYCLE_RULE_ID), spootieRule],
      },
    }),
  );

  // Read back to confirm it stuck.
  const readBack = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: config.bucket }),
  );
  const applied = readBack.Rules?.find((rule) => rule.ID === LIFECYCLE_RULE_ID);
  if (applied?.Expiration?.Days !== config.expiryDays) {
    throw new Error("lifecycle rule read-back did not match what was written");
  }
}

// --- verified test upload ----------------------------------------------------

async function verifyUploadStep(client: S3Client, config: Config): Promise<void> {
  const tempPath = join(tmpdir(), `spootie-setup-test-${Date.now()}.txt`);
  await Bun.write(tempPath, "spootie setup test\n");

  let uploaded: { url: string; key: string };
  try {
    uploaded = await uploadFile(tempPath, config);
  } catch (err) {
    if (isBadCredentials(err)) failBadCredentials(err);
    console.error(`✗ Test upload failed: ${errorMessage(err)}`);
    if (isAccessDenied(err)) {
      console.error(
        '  The API token cannot write to the bucket. Check that it has at least "Object Read & Write" scope for this bucket, and that the bucket name is correct.',
      );
    }
    process.exit(1);
  } finally {
    await unlink(tempPath).catch(() => {});
  }

  try {
    const response = await fetch(uploaded.url);
    if (response.ok) {
      console.log(`✓ Test upload publicly reachable: ${uploaded.url}`);
    } else {
      console.error(
        `✗ Test object uploaded, but its public URL returned HTTP ${response.status}:\n` +
          `  ${uploaded.url}\n` +
          "  Public access is likely not enabled for the bucket, or publicBaseUrl is wrong.\n" +
          "  In the Cloudflare dashboard: R2 -> your bucket -> Settings -> Public access ->\n" +
          '  r2.dev subdomain -> "Allow Access", then use the shown https://pub-....r2.dev URL\n' +
          "  as publicBaseUrl and re-run `spootie setup`.",
      );
      process.exitCode = 1;
    }
  } finally {
    // Clean up the test object regardless of the public-access result.
    await client
      .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: uploaded.key }))
      .catch(() => {});
  }

  if (process.exitCode === 1) process.exit(1);
}

function failBadCredentials(err: unknown): never {
  console.error(
    `✗ R2 rejected the credentials (${errorName(err) || "auth error"}).\n` +
      "  Check accountId, accessKeyId and secretAccessKey, then re-run `spootie setup`.",
  );
  process.exit(1);
}
