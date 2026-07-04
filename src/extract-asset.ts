/**
 * Extracts an embedded, spawnable executable (see embedded-assets.ts) to a
 * real path on disk. Needed because a compiled binary's embedded assets live
 * inside $bunfs, and $bunfs paths cannot be posix_spawn'd — only Bun's own
 * file APIs (Bun.file/Bun.write) can read them.
 */
import { chmod, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./state.ts";

/**
 * Copies `embeddedPath` to `destPath` (creating a private 0700 parent dir)
 * and marks it executable, then returns `destPath`. Skips the copy if a file
 * already sits at `destPath` with byte-identical content to the embedded
 * source, so a running daemon's already-extracted binary is never clobbered
 * on every start — only a genuine change (a new spootie build with a
 * different vendored binary) triggers a rewrite. Content, not just size, is
 * compared: two different builds of alerter can plausibly land on the same
 * size, so size alone is not a sound identity check.
 *
 * The rewrite itself is atomic: the new content is written to a
 * `.<pid>.tmp` sibling (unique per process, since two processes — e.g. a
 * manual `spootie watch` and the LaunchAgent both draining a queue at
 * startup — can race to extract at once), chmod'd, then renamed over
 * `destPath` (same pattern as queue.ts/history.ts), so a concurrent
 * extractor never observes a momentarily truncated binary at `destPath`. If
 * the write/chmod/rename fails, the pid-named temp file is best-effort
 * cleaned up so failed extractions don't strand it.
 */
export const extractExecutable = async (
  embeddedPath: string,
  destPath: string,
): Promise<string> => {
  const src = Bun.file(embeddedPath);
  const dest = Bun.file(destPath);

  const upToDate =
    (await dest.exists()) &&
    dest.size === src.size &&
    Bun.hash(await dest.arrayBuffer()) === Bun.hash(await src.arrayBuffer());

  if (!upToDate) {
    await ensurePrivateDir(dirname(destPath));
    const tmpPath = `${destPath}.${process.pid}.tmp`;
    try {
      await Bun.write(tmpPath, src);
      await chmod(tmpPath, 0o755);
      await rename(tmpPath, destPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  return destPath;
};
