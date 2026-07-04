import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isCompiledBinary } from "./runtime.ts";
import { ensurePrivateDir } from "./state.ts";

const LABEL = "com.spootie.watch";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const LOG_PATH = join(homedir(), ".config", "spootie", "logs", "spootie.log");

/**
 * Arguments launchd should exec. When an explicit `binaryPath` is given (e.g.
 * the build installs to a stable ~/.local/bin/spootie and refreshes the agent
 * to point there), launchd is aimed straight at it. Otherwise, when this
 * process IS the compiled binary, process.execPath is that binary, so we point
 * launchd at it (no bun, no source tree needed at runtime); in dev
 * (`bun run src/index.ts install`), process.execPath is the `bun` interpreter,
 * so we keep the old bun+entry-script form. isCompiledBinary() tells the two
 * apart (see runtime.ts).
 */
const programArguments = (binaryPath?: string): string[] => {
    if (binaryPath !== undefined) return [binaryPath, "watch"];
    return isCompiledBinary()
        ? [process.execPath, "watch"]
        : [process.execPath, "run", join(import.meta.dir, "index.ts"), "watch"];
};

/** Escapes a string for safe embedding in plist XML text content. */
const escapeXml = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const plistContent = (binaryPath?: string): string => {
    // LaunchAgents run without the user's shell PATH, so everything must be
    // absolute; pbcopy/osascript/mdls/defaults live in /usr/bin, so the PATH
    // below still matters even though alerter itself is invoked by absolute
    // path (extracted from the embedded asset, see notify.ts) and no longer
    // needs to be found on it.
    const agentPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    const argsXml = programArguments(binaryPath)
        .map((arg) => `    <string>${escapeXml(arg)}</string>`)
        .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG_PATH)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(agentPath)}</string>
  </dict>
</dict>
</plist>
`;
};

const launchctl = (args: string[]): { ok: boolean; output: string } => {
    const result = Bun.spawnSync(["launchctl", ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    return { ok: result.exitCode === 0, output };
};

const guiDomain = (): string => `gui/${process.getuid?.() ?? 501}`;

/** True if launchd currently has the agent loaded. */
export const isAgentLoaded = (): boolean => launchctl(["print", `${guiDomain()}/${LABEL}`]).ok;

export const isAgentInstalled = (): Promise<boolean> => Bun.file(PLIST_PATH).exists();

/**
 * Write the plist and (re)load it. Safe to run when already installed. When
 * `binaryPath` is given, the plist's ProgramArguments point at that stable
 * path instead of process.execPath — the build passes ~/.local/bin/spootie so
 * a rebuild that replaces the binary in place doesn't strand the agent on a
 * stale inode.
 */
export const installAgent = async (binaryPath?: string): Promise<void> => {
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    // launchd will not create the log directory itself; make sure it exists
    // (private — the log records upload URLs) before the plist points
    // StandardOut/ErrorPath at it.
    await ensurePrivateDir(dirname(LOG_PATH));
    await Bun.write(PLIST_PATH, plistContent(binaryPath));
    console.log(`✓ LaunchAgent written to ${PLIST_PATH}`);

    // Reinstall cleanly: unload any existing instance first (ignore "not
    // loaded" errors).
    launchctl(["bootout", `${guiDomain()}/${LABEL}`]);

    const bootstrap = launchctl(["bootstrap", guiDomain(), PLIST_PATH]);
    if (!bootstrap.ok) {
        // Older fallback interface.
        const load = launchctl(["load", PLIST_PATH]);
        if (!load.ok) {
            throw new Error(
                `Could not load the LaunchAgent.\n` +
                    `  launchctl bootstrap: ${bootstrap.output || "(no output)"}\n` +
                    `  launchctl load: ${load.output || "(no output)"}`,
            );
        }
    }

    console.log("✓ Loaded — spootie watch now runs at login (and restarts on crash)");
    console.log(`  Logs: ${LOG_PATH}`);
};

/** Unload the agent and remove the plist. Safe to run when not installed. */
export const uninstallAgent = async (): Promise<void> => {
    const wasInstalled = await isAgentInstalled();

    const bootout = launchctl(["bootout", `${guiDomain()}/${LABEL}`]);
    if (!bootout.ok && wasInstalled) {
        // Older fallback interface; ignore failures (it may simply not be loaded).
        launchctl(["unload", PLIST_PATH]);
    }
    console.log("✓ Stopped (if it was running)");

    if (wasInstalled) {
        await unlink(PLIST_PATH).catch(() => {});
        console.log(`✓ Removed ${PLIST_PATH}`);
    } else {
        console.log("LaunchAgent was not installed; nothing to remove.");
    }
};
