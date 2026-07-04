#!/usr/bin/env bun
/**
 * Builds the distributable artifacts for spootie — the one command
 * teammates run after `bun install` to get a runnable daemon (and, on a
 * Mac, the menu bar app):
 *
 *  - dist/spootie: a self-contained daemon binary (`bun build --compile`).
 *    vendor/alerter, public/variant-a.html and
 *    public/vendor/preact-standalone.mjs are embedded into it via
 *    `with { type: "file" }` imports (see src/embedded-assets.ts) — no
 *    separate asset files need to ship alongside the binary.
 *  - dist/spootie-menubar: the Swift menu bar app. macOS only (needs the
 *    swiftc that ships with Xcode/Command Line Tools); skipped elsewhere.
 *
 * No Xcode project and no code signing for either binary.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PLIST_PATH } from "../src/launchagent.ts";

const ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");

/** Runs `cmd`, streaming its output, and exits the script on failure. */
const run = (cmd: string[]): void => {
  console.log(`$ ${cmd.join(" ")}`);
  const result = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`\nCommand failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
    process.exit(result.exitCode ?? 1);
  }
};

const main = async (): Promise<void> => {
  await mkdir(DIST_DIR, { recursive: true });

  const spootieOut = join(DIST_DIR, "spootie");
  run([
    "bun",
    "build",
    "--compile",
    "--minify",
    join(ROOT, "src", "index.ts"),
    "--outfile",
    spootieOut,
  ]);
  console.log(`✓ Built ${spootieOut}`);

  // bun build --compile atomically replaces dist/spootie, but a running
  // LaunchAgent daemon keeps executing the old (now-unlinked) inode
  // indefinitely — it never picks up the new binary on its own. Nudge
  // whoever just rebuilt to reinstall, but never let this check itself fail
  // the build (e.g. on Linux, where the LaunchAgent path doesn't apply).
  try {
    if (await Bun.file(PLIST_PATH).exists()) {
      console.log(
        `Note: a LaunchAgent is installed at ${PLIST_PATH}. It's still ` +
          "running the old binary — re-run `./dist/spootie install` to restart " +
          "the daemon on this build.",
      );
    }
  } catch {
    // Best-effort reminder only; ignore failures.
  }

  if (process.platform === "darwin") {
    const menubarOut = join(DIST_DIR, "spootie-menubar");
    run(["swiftc", "-O", "-o", menubarOut, join(ROOT, "menubar", "main.swift")]);
    console.log(`✓ Built ${menubarOut}`);
  } else {
    console.log(
      "Skipping the menu bar app: it only builds on macOS (needs swiftc). " +
        "Run `bun run build` on a Mac to also get dist/spootie-menubar.",
    );
  }
};

main();
