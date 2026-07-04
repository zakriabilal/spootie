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
import { migrateLastUpload, readLastUpload, recordUpload } from "./history.ts";
import {
  installAgent,
  isAgentInstalled,
  isAgentLoaded,
  uninstallAgent,
} from "./launchagent.ts";
import { readQueueLength, UploadQueue } from "./queue.ts";
import { readUiInfo, startUiServer, uiUrl } from "./server.ts";
import { runSetup } from "./setup.ts";
import { isPaused, migrateLegacyState, setPaused } from "./state.ts";
import { uploadFile } from "./upload.ts";
import { getScreenshotFolder, watchScreenshots } from "./watcher.ts";

const runWatch = async (): Promise<void> => {
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

  const ui = await startUiServer({ queue, config });

  const folder = getScreenshotFolder();
  console.log(`spootie: watching for screenshots in ${folder}`);
  console.log(`spootie: dashboard at ${uiUrl(ui.port, ui.token)}`);
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
    ui.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

const handleScreenshot = async (
  path: string,
  config: Config,
  queue: UploadQueue,
): Promise<void> => {
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
    const { url, key } = await uploadFile(path, config);
    await copyToClipboard(url);
    await recordUpload({
      key,
      url,
      fileName: name,
      uploadedAt: new Date().toISOString(),
    });
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
};

const runLast = async (): Promise<void> => {
  const last = await readLastUpload();
  if (last === null) {
    console.error("No uploads yet.");
    process.exit(1);
  }
  // URL alone on stdout so it is pipeable; timestamp on stderr.
  console.log(last.url);
  console.error(`uploaded at ${last.uploadedAt}`);
};

const runStatus = async (): Promise<void> => {
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

  const ui = await readUiInfo();
  console.log(
    `Dashboard: ${ui ? uiUrl(ui.port, ui.token) : "not running (start `spootie watch`)"}`,
  );
};

const runUi = async (): Promise<void> => {
  const ui = await readUiInfo();
  if (ui === null) {
    console.error(
      "The daemon isn't running, so there's no dashboard to open.\n" +
        "Start it with `spootie watch` (or `spootie install` to run it in the background).",
    );
    process.exit(1);
  }
  const url = uiUrl(ui.port, ui.token);
  const open = Bun.spawnSync(["open", url]);
  if (open.exitCode !== 0) {
    console.error(`Could not open the browser. The dashboard is at ${url}`);
    process.exit(1);
  }
  console.log(`Opening ${url}`);
};

const run = (task: () => Promise<void>, options: { exitWhenDone?: boolean } = {}): void => {
  // Move any state files from the legacy location first, then fold the legacy
  // last-upload.json into history.json (both best-effort, never throw) so every
  // command sees the queue, pause flag and last upload.
  migrateLegacyState()
    .then(migrateLastUpload)
    .then(task)
    .then(() => {
      if (options.exitWhenDone) process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
};

const main = (): void => {
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
    case "ui":
      run(runUi);
      break;
    default:
      console.error(
        "Usage: spootie <setup|watch|install|uninstall|pause|resume|last|status|ui>",
      );
      process.exit(1);
  }
};

main();
