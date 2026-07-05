import { errorMessage } from "./errors.ts";

/** Copy text to the macOS clipboard via pbcopy. */
export const copyToClipboard = async (text: string): Promise<void> => {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stderr: "pipe" });
    proc.stdin.write(text);
    await proc.stdin.end();

    const code = await proc.exited;
    if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`pbcopy failed (exit ${code}): ${stderr.trim()}`);
    }
};

/**
 * Copy a freshly uploaded URL to the clipboard, logging but never throwing on
 * failure (e.g. no clipboard available) so a stray pbcopy error can't turn a
 * successful upload into a failed request.
 */
export const copyUrlBestEffort = async (url: string): Promise<void> => {
    await copyToClipboard(url).catch((err: unknown) => {
        console.error(`spootie: could not copy uploaded URL to clipboard: ${errorMessage(err)}`);
    });
};
