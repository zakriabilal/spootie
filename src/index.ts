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
import {
  installAgent,
  isAgentInstalled,
  isAgentLoaded,
  uninstallAgent,
} from "./launchagent.ts";
import { readQueueLength, UploadQueue } from "./queue.ts";
import { runSetup } from "./setup.ts";
import {
  isPaused,
  readLastUpload,
  recordLastUpload,
  setPaused,
} from "./state.ts";
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
  if (await isPaused()) {
    console.log("spootie: currently PAUSED — run `spootie resume` to resume.");
  }
  console.log("Press Ctrl+C to stop.");

  const handle = watchScreenshots(folder, (path) => {
    // Catch anything that escapes (e.g. a failed queue persist) so it logs
    // instead of becoming an unhandled rejection.
    handleScreenshot(path, config, queue).catch((err: unknown) => {
      console.error(`spootie: screenshot handling failed: ${errorMessage(err)}`);
    });
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

  if (await isPaused()) {
    console.log(`spootie: paused — ignoring ${name}`);
    return;
  }

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
    await recordLastUpload(url);
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

async function runLast(): Promise<void> {
  const last = await readLastUpload();
  if (last === null) {
    console.error("No uploads yet.");
    process.exit(1);
  }
  // URL alone on stdout so it is pipeable; timestamp on stderr.
  console.log(last.url);
  console.error(`uploaded at ${last.uploadedAt}`);
}

async function runStatus(): Promise<void> {
  const installed = await isAgentInstalled();
  const agentLine = installed
    ? isAgentLoaded()
      ? "installed and loaded"
      : "installed (not loaded)"
    : "not installed";
  console.log(`LaunchAgent: ${agentLine}`);

  console.log(`Paused: ${(await isPaused()) ? "yes" : "no"}`);

  const queueLength = await readQueueLength();
  console.log(`Queue: ${queueLength} pending upload(s)`);

  const last = await readLastUpload();
  console.log(`Last upload: ${last ? `${last.uploadedAt} (${last.url})` : "none yet"}`);
}

function run(task: () => Promise<void>, options: { exitWhenDone?: boolean } = {}): void {
  task()
    .then(() => {
      if (options.exitWhenDone) process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

function main(): void {
  const command = process.argv[2];

  switch (command) {
    case "watch":
      run(runWatch);
      break;
    case "setup":
      // Explicit exit: the interactive stdin reader would otherwise keep the
      // process alive after setup finishes.
      run(runSetup, { exitWhenDone: true });
      break;
    case "install":
      run(installAgent);
      break;
    case "uninstall":
      run(uninstallAgent);
      break;
    case "pause":
      run(async () => {
        await setPaused(true);
        console.log("spootie paused — new screenshots will be ignored. Run `spootie resume` to resume.");
      });
      break;
    case "resume":
      run(async () => {
        await setPaused(false);
        console.log("spootie resumed — new screenshots will prompt for upload again.");
      });
      break;
    case "last":
      run(runLast);
      break;
    case "status":
      run(runStatus);
      break;
    default:
      console.error(
        "Usage: spootie <setup|watch|install|uninstall|pause|resume|last|status>",
      );
      process.exit(1);
  }
}

main();
