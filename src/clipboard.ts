/** Copy text to the macOS clipboard via pbcopy. */
export async function copyToClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stderr: "pipe" });
  proc.stdin.write(text);
  await proc.stdin.end();

  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`pbcopy failed (exit ${code}): ${stderr.trim()}`);
  }
}
