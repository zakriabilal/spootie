import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LABEL = "com.spootie.watch";
export const PLIST_PATH = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LABEL}.plist`,
);
export const LOG_PATH = join(homedir(), "Library", "Logs", "spootie.log");

function plistContent(): string {
  // LaunchAgents run without the user's shell PATH, so everything must be
  // absolute: the bun binary, the entry script, and a PATH that lets the
  // daemon find `alerter` (and pbcopy/osascript in /usr/bin).
  const bunPath = process.execPath;
  const entryPath = join(import.meta.dir, "index.ts");
  const agentPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${entryPath}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${agentPath}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync(["launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  return { ok: result.exitCode === 0, output };
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/** True if launchd currently has the agent loaded. */
export function isAgentLoaded(): boolean {
  return launchctl(["print", `${guiDomain()}/${LABEL}`]).ok;
}

export function isAgentInstalled(): Promise<boolean> {
  return Bun.file(PLIST_PATH).exists();
}

/** Write the plist and (re)load it. Safe to run when already installed. */
export async function installAgent(): Promise<void> {
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await mkdir(join(homedir(), "Library", "Logs"), { recursive: true });
  await Bun.write(PLIST_PATH, plistContent());
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
}

/** Unload the agent and remove the plist. Safe to run when not installed. */
export async function uninstallAgent(): Promise<void> {
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
}
