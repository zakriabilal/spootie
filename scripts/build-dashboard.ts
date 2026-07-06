#!/usr/bin/env bun
/**
 * Bundles the Preact dashboard (src/dashboard/*) into a single self-contained
 * `dist/dashboard.html` — CSS inlined as <style>, the bundled+minified JS
 * inlined as a <script type="module">. That one file is what src/daemon/assets.ts
 * embeds into the compiled binary and what the daemon serves at `/`, so the
 * runtime side never changes shape: it's always one HTML file.
 *
 * Run directly to build once, or with `--watch` to rebuild on source changes
 * (the daemon reads the file per request, so a browser reload picks up edits).
 */
import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src", "dashboard");
const OUT_DIR = join(ROOT, "dist");
const OUT = join(OUT_DIR, "dashboard.html");

// Neutralise a closing tag that would otherwise break out of the <script>/<style>
// element it's inlined into (e.g. inside a JS string literal).
const escapeFor = (tag: "script" | "style", body: string): string =>
    body.replaceAll(`</${tag}`, `<\\/${tag}`);

export const buildDashboard = async (): Promise<void> => {
    const result = await Bun.build({
        entrypoints: [join(SRC, "index.tsx")],
        target: "browser",
        minify: true,
    });
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        throw new Error("Dashboard bundle failed");
    }
    const out = result.outputs[0];
    if (!out) throw new Error("Dashboard bundle produced no output");

    const js = await out.text();
    const css = await Bun.file(join(SRC, "styles.css")).text();
    const shell = await Bun.file(join(SRC, "index.html")).text();

    // Function replacements so `$` in the bundled JS/CSS isn't treated as a
    // String.replace special pattern.
    const html = shell
        .replace("/*__CSS__*/", () => escapeFor("style", css))
        .replace("/*__JS__*/", () => escapeFor("script", js));

    await mkdir(OUT_DIR, { recursive: true });
    await Bun.write(OUT, html);
};

if (import.meta.main) {
    await buildDashboard();
    console.log(`✓ Built ${OUT}`);

    if (process.argv.includes("--watch")) {
        console.log("Watching src/dashboard for changes...");
        let building = false;
        watch(SRC, { recursive: true }, () => {
            if (building) return;
            building = true;
            buildDashboard()
                .then(() => console.log("↻ Rebuilt dashboard"))
                .catch((err: unknown) => console.error(err))
                .finally(() => {
                    building = false;
                });
        });
    }
}
