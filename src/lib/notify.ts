/**
 * macOS notifications. Fire-and-forget, using AppleScript's `display
 * notification`.
 */

const APP_TITLE = "spootie";

/** Fire-and-forget informational notification. */
export const notify = (message: string, subtitle?: string): void => {
    displayNotification(message, subtitle);
};

/** Fire-and-forget error notification. */
export const notifyError = (message: string): void => {
    displayNotification(message, "Error");
};

const displayNotification = (message: string, subtitle?: string): void => {
    const script =
        `display notification ${quote(message)} ` +
        `with title ${quote(APP_TITLE)}` +
        (subtitle ? ` subtitle ${quote(subtitle)}` : "");

    // Detached and non-blocking; we don't care about the result.
    Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
    });
};

/** Quote a string for safe embedding in an AppleScript literal. */
const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
