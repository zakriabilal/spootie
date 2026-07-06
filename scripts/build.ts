#!/usr/bin/env bun
/**
 * Builds AND installs spootie — the one command teammates run after
 * `bun install` to get a runnable daemon on their PATH:
 *
 *  - dist/spootie: a self-contained daemon binary (`bun build --compile`).
 *    The bundled dashboard (dist/dashboard.html, built here from
 *    src/dashboard/* first) and public/favicon.svg are embedded into it via
 *    `with { type: "file" }` imports (see src/daemon/assets.ts) — no separate
 *    asset files need to ship alongside the binary.
 *  - ~/.local/bin/spootie: the compiled binary, installed to a stable path so
 *    `spootie` is runnable directly and the LaunchAgent can point at an inode
 *    that survives rebuilds.
 *
 * On macOS, if a LaunchAgent is already installed, it's re-installed against
 * the stable ~/.local/bin/spootie path so the running daemon picks up this
 * build. On Linux (the dev box) the binary is still copied — handy for
 * iterating — but the launchctl/plist work is skipped.
 */
import { chmod, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installAgent, PLIST_PATH } from "../src/commands/launchagent.ts";
import { buildDashboard } from "./build-dashboard.ts";

const ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");
const INSTALL_DIR = join(homedir(), ".local", "bin");
const INSTALL_PATH = join(INSTALL_DIR, "spootie");

/** Runs `cmd`, streaming its output, and exits the script on failure. */
const run = (cmd: string[]): void => {
    console.log(`$ ${cmd.join(" ")}`);
    const result = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
        console.error(`\nCommand failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
        process.exit(result.exitCode ?? 1);
    }
};

/**
 * Copies `src` onto `dest` atomically. The destination may be a currently
 * running binary, so we write a temp file in the same directory (same
 * filesystem, so rename is atomic), chmod it executable, then rename it over
 * the target. rename replaces the directory entry without truncating the old
 * inode, so a process still executing the previous build keeps running
 * unharmed until it restarts.
 */
const installBinary = async (src: string, dest: string): Promise<void> => {
    await mkdir(INSTALL_DIR, { recursive: true });
    const tmp = join(INSTALL_DIR, `.spootie.${process.pid}.tmp`);
    await Bun.write(tmp, Bun.file(src));
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
};

/**
 * Warn (never modify the user's shell profile) if the install dir isn't on
 * PATH, so `spootie` won't resolve without the full path.
 */
const checkPath = (): void => {
    const entries = (process.env.PATH ?? "").split(":");
    if (entries.includes(INSTALL_DIR)) return;
    console.log("");
    console.log(`Warning: ${INSTALL_DIR} is not on your PATH, so \`spootie\` won't be found.`);
    console.log("Add it by appending this line to your shell profile (~/.zshrc or ~/.bashrc):");
    console.log("");
    console.log('    export PATH="$HOME/.local/bin:$PATH"');
    console.log("");
    console.log("Then open a new terminal (or `source` that file) and re-run.");
};

const main = async (): Promise<void> => {
    await mkdir(DIST_DIR, { recursive: true });

    // Bundle the dashboard first: `bun build --compile` below embeds
    // dist/dashboard.html via src/daemon/assets.ts, so it must exist and be
    // current before we compile.
    await buildDashboard();
    console.log("✓ Built dist/dashboard.html");

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

    await installBinary(spootieOut, INSTALL_PATH);
    console.log(`✓ Installed ${INSTALL_PATH}`);

    checkPath();

    // Refresh the running daemon. `bun build --compile` replaced dist/spootie
    // and the copy above replaced ~/.local/bin/spootie, but a LaunchAgent
    // already loaded keeps executing whatever inode it launched — it never
    // picks up a new build on its own. Re-install the agent (aimed at the
    // stable ~/.local/bin/spootie path) so launchd restarts it on this build.
    // macOS only: launchctl doesn't exist on the Linux dev box, so gate the
    // whole thing on the platform.
    if (process.platform === "darwin" && (await Bun.file(PLIST_PATH).exists())) {
        console.log("Refreshing the installed LaunchAgent to run this build...");
        try {
            await installAgent(INSTALL_PATH);
        } catch (err) {
            // The binary is installed regardless; a launchctl hiccup shouldn't
            // fail the build. Surface it so the user can re-run `spootie
            // install` by hand.
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`Warning: could not refresh the LaunchAgent: ${message}`);
            console.warn("Run `spootie install` to restart the daemon on this build.");
        }
    }
};

main();
