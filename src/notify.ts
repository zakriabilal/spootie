/**
 * macOS notifications.
 *
 * Actionable notifications (with an "Upload" button) use `alerter`, a small
 * notification CLI that blocks until the user interacts and reports which
 * action was taken. Plain notifications use AppleScript's `display
 * notification`, which is fire-and-forget.
 */

const ALERTER_BIN = "alerter";
const APP_TITLE = "spootie";

/** How long the actionable notification stays interactive, in seconds. */
const ACTION_TIMEOUT_SECONDS = 60;

export class AlerterMissingError extends Error {
  constructor() {
    super(
      "The 'alerter' command was not found. Install it with:\n" +
        "  brew install alerter",
    );
    this.name = "AlerterMissingError";
  }
}

export function isAlerterInstalled(): boolean {
  return Bun.which(ALERTER_BIN) !== null;
}

interface AlerterResult {
  activationType?: string;
  activationValue?: string;
}

/**
 * Show a notification with an "Upload" action button and wait for the user.
 * Resolves true only if the user clicks "Upload"; false if they dismiss,
 * ignore, or it times out.
 */
export async function confirmUpload(fileName: string): Promise<boolean> {
  if (!isAlerterInstalled()) throw new AlerterMissingError();

  const proc = Bun.spawn(
    [
      ALERTER_BIN,
      "-json",
      "-title",
      APP_TITLE,
      "-subtitle",
      "New screenshot",
      "-message",
      fileName,
      "-actions",
      "Upload",
      "-timeout",
      String(ACTION_TIMEOUT_SECONDS),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  let result: AlerterResult;
  try {
    result = JSON.parse(stdout.trim()) as AlerterResult;
  } catch {
    // Unparseable output — treat as "no action taken" rather than uploading.
    return false;
  }

  return (
    result.activationType === "actionClicked" &&
    result.activationValue === "Upload"
  );
}

/** Fire-and-forget informational notification. */
export function notify(message: string, subtitle?: string): void {
  displayNotification(message, subtitle);
}

/** Fire-and-forget error notification. */
export function notifyError(message: string): void {
  displayNotification(message, "Error");
}

function displayNotification(message: string, subtitle?: string): void {
  const script =
    `display notification ${quote(message)} ` +
    `with title ${quote(APP_TITLE)}` +
    (subtitle ? ` subtitle ${quote(subtitle)}` : "");

  // Detached and non-blocking; we don't care about the result.
  Bun.spawn(["osascript", "-e", script], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** Quote a string for safe embedding in an AppleScript literal. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
