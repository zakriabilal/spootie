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

  const folder = getScreenshotFolder();
  console.log(`spootie: watching for screenshots in ${folder}`);
  console.log("Press Ctrl+C to stop.");

  const handle = watchScreenshots(folder, (path) => {
    void handleScreenshot(path, config);
  });

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleScreenshot(path: string, config: Config): Promise<void> {
  const name = basename(path);
  try {
    const wantsUpload = await confirmUpload(name);
    if (!wantsUpload) return;

    const url = await uploadFile(path, config);
    await copyToClipboard(url);
    notify(url, "Uploaded — URL copied");
    console.log(`Uploaded ${name} -> ${url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Upload failed for ${name}: ${message}`);
    notifyError(`Upload failed for ${name}`);
  }
}

function main(): void {
  const command = process.argv[2];

  switch (command) {
    case "watch":
      void runWatch();
      break;
    default:
      console.error("Usage: spootie watch");
      process.exit(1);
  }
}

main();
