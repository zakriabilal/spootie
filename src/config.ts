import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
  expiryDays: number;
}

export const CONFIG_PATH = join(homedir(), ".config", "spootie", "config.json");

const REQUIRED_STRING_KEYS = [
  "accountId",
  "accessKeyId",
  "secretAccessKey",
  "bucket",
  "publicBaseUrl",
] as const;

/**
 * Load and validate the config file. Throws with a clear, user-facing message
 * if the file is missing or malformed.
 */
export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);

  if (!(await file.exists())) {
    throw new Error(
      `Config file not found at ${CONFIG_PATH}.\n` +
        `Create it with your Cloudflare R2 credentials. See the README for the format.`,
    );
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new Error(`Config file at ${CONFIG_PATH} is not valid JSON.`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Config file at ${CONFIG_PATH} must contain a JSON object.`);
  }

  const obj = raw as Record<string, unknown>;

  for (const key of REQUIRED_STRING_KEYS) {
    const value = obj[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `Config field "${key}" is missing or empty in ${CONFIG_PATH}.`,
      );
    }
  }

  let expiryDays = 7;
  if (obj.expiryDays !== undefined) {
    if (typeof obj.expiryDays !== "number" || obj.expiryDays <= 0) {
      throw new Error(
        `Config field "expiryDays" must be a positive number in ${CONFIG_PATH}.`,
      );
    }
    expiryDays = obj.expiryDays;
  }

  // Normalise: strip any trailing slash from the public base URL so we can
  // always join with a single "/".
  const publicBaseUrl = (obj.publicBaseUrl as string).replace(/\/+$/, "");

  return {
    accountId: obj.accountId as string,
    accessKeyId: obj.accessKeyId as string,
    secretAccessKey: obj.secretAccessKey as string,
    bucket: obj.bucket as string,
    publicBaseUrl,
    expiryDays,
  };
}
