#!/usr/bin/env bun
import { basename } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { copyToClipboard } from "./clipboard.ts";
import {
  AlerterMissingError,
  confirmUpload,
  isAlerterInstalled,
  notify,
  notifyError,
} from "./notify.ts";
import { errorMessage, isRetryableNetworkError } from "./errors.ts";
import { UploadQueue } from "./queue.ts";
import { runSetup } from "./setup.ts";
import { uploadFile } from "./upload.ts";
import { getScreenshotFolder, watchScreenshots } from "./watcher.ts";

async function runWatch(): Promise<void> {
  if (!isAlerterInstalled()) {
    console.error(new AlerterMissingError().message);
    process.exit(1);
  }

  let config: Config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const queue = new UploadQueue(config);
  await queue.start();

  const folder = getScreenshotFolder();
  console.log(`spootie: watching for screenshots in ${folder}`);
  console.log("Press Ctrl+C to stop.");

  const handle = watchScreenshots(folder, (path) => {
    void handleScreenshot(path, config, queue);
  });

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleScreenshot(
  path: string,
  config: Config,
  queue: UploadQueue,
): Promise<void> {
  const name = basename(path);
  try {
    const wantsUpload = await confirmUpload(name);
    if (!wantsUpload) return;
  } catch (err) {
    console.error(`Notification failed for ${name}: ${errorMessage(err)}`);
    return;
  }

  try {
    const { url } = await uploadFile(path, config);
    await copyToClipboard(url);
    notify(url, "Uploaded — URL copied");
    console.log(`Uploaded ${name} -> ${url}`);
  } catch (err) {
    if (isRetryableNetworkError(err)) {
      console.error(`Upload failed for ${name} (network): ${errorMessage(err)}`);
      await queue.enqueue(path);
      return;
    }
    console.error(`Upload failed for ${name}: ${errorMessage(err)}`);
    notifyError(`Upload failed for ${name}`);
  }
}

function main(): void {
  const command = process.argv[2];

  switch (command) {
    case "watch":
      void runWatch();
      break;
    case "setup":
      runSetup()
        // Explicit exit: the interactive stdin reader would otherwise keep
        // the process alive after setup finishes.
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        });
      break;
    default:
      console.error("Usage: spootie <setup|watch>");
      process.exit(1);
  }
}

main();
