/**
 * True when running as a `bun build --compile` binary rather than via
 * `bun run`/`bunx`. A compiled spootie binary always embeds at least one
 * asset (vendor/alerter, public/variant-a.html, ...) via `with { type: "file" }`
 * imports (see embedded-assets.ts); a plain `bun run` process never populates
 * `Bun.embeddedFiles`, since those imports just resolve to real paths on disk
 * instead of being bundled in. This is more reliable than sniffing
 * `process.execPath`'s basename, which would misfire if someone happened to
 * name the compiled binary "bun".
 */
export const isCompiledBinary = (): boolean => Bun.embeddedFiles.length > 0;
