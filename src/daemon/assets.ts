/**
 * Assets bundled into the daemon at compile time, via Bun's file-embedding
 * import form (`with { type: "file" }`). Each import resolves to a path:
 *
 *  - Under `bun run`, that path is the real file on disk (import.meta.dir
 *    semantics), so dev and the compiled binary share one code path.
 *  - Under a `bun build --compile` binary, it's a path inside the embedded
 *    $bunfs. Bun.file()/Bun.write() can read straight out of $bunfs, so
 *    serving these as static files works unchanged.
 *
 * Centralized here so every consumer (server.ts) imports the resolved path
 * rather than re-deriving it from import.meta.dir, which does not point at
 * the repo once compiled.
 *
 * dist/dashboard.html is a build artifact: `scripts/build-dashboard.ts` bundles
 * src/dashboard/* into that single self-contained file. It must exist before
 * this module loads — `bun run build` and `bun run dev` both build it first.
 */
import dashboardHtmlAsset from "../../dist/dashboard.html" with { type: "file" };
import faviconSvgAsset from "../../public/favicon.svg" with { type: "file" };

export const DASHBOARD_HTML_ASSET: string = dashboardHtmlAsset;
export const FAVICON_SVG_ASSET: string = faviconSvgAsset;
