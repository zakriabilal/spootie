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
 * Resolves true if the user clicks "Upload" or the notification body; false
 * if they dismiss, ignore, or it times out.
 */
export function confirmUpload(fileName: string): Promise<boolean> {
  return askAction("New screenshot", fileName, "Upload");
}

/**
 * After a queued upload completes, offer to copy its URL (we must not clobber
 * the clipboard unprompted). Resolves true if the user clicks "Copy URL" or
 * the notification body.
 */
export function offerCopyUrl(url: string): Promise<boolean> {
  return askAction("Queued upload finished", url, "Copy URL");
}

/**
 * Show an actionable notification with a single affirmative button and wait.
 * Resolves true if the user clicks the button or the notification body; false
 * if they dismiss, ignore, or it times out.
 */
async function askAction(
  subtitle: string,
  message: string,
  action: string,
): Promise<boolean> {
  if (!isAlerterInstalled()) throw new AlerterMissingError();

  const proc = Bun.spawn(
    [
      ALERTER_BIN,
      "-json",
      "-title",
      APP_TITLE,
      "-subtitle",
      subtitle,
      "-message",
      message,
      "-actions",
      action,
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
    // Unparseable output — treat as "no action taken".
    return false;
  }

  // The single action is the only affirmative choice, so a click on the
  // notification body also counts — the action button is only visible on
  // hover and only with the "Alerts" notification style.
  if (result.activationType === "contentsClicked") return true;
  return (
    result.activationType === "actionClicked" &&
    result.activationValue === action
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
