/**
 * Assets bundled into the daemon at compile time, via Bun's file-embedding
 * import form (`with { type: "file" }`). Each import resolves to a path:
 *
 *  - Under `bun run`, that path is the real file on disk (import.meta.dir
 *    semantics), so dev and the compiled binary share one code path.
 *  - Under a `bun build --compile` binary, it's a path inside the embedded
 *    $bunfs (e.g. `/$bunfs/root/alerter-xxxx.`). Bun.file()/Bun.write() can
 *    read straight out of $bunfs, so serving static files works unchanged.
 *    Spawning an executable from $bunfs does NOT work (posix_spawn ENOENTs),
 *    so vendor/alerter must be extracted to a real path first — see
 *    extract-asset.ts and notify.ts.
 *
 * Centralized here so every consumer (server.ts, notify.ts) imports the
 * resolved path rather than re-deriving it from import.meta.dir, which does
 * not point at the repo once compiled.
 */
// The static `with { type: "file" }` form below is what makes Bun embed
// vendor/alerter into the compiled binary (and, under `bun run`, resolve to
// its real on-disk path) — it can't be swapped for a dynamic/lazy import
// without losing that embedding. If vendor/alerter is missing, module
// resolution fails right here with a raw Bun error before main() ever runs
// (in both dev and `bun build --compile`, which fails the build outright).
// Accepted: the file is committed to the repo, so a checkout missing it is
// already broken.
import alerterAsset from "../vendor/alerter" with { type: "file" };
import dashboardHtmlAsset from "../public/dashboard.html" with { type: "file" };
import preactStandaloneAsset from "../public/vendor/preact-standalone.mjs" with { type: "file" };

export const ALERTER_ASSET: string = alerterAsset;
export const DASHBOARD_HTML_ASSET: string = dashboardHtmlAsset;
export const PREACT_STANDALONE_ASSET: string = preactStandaloneAsset;
