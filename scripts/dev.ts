#!/usr/bin/env bun
/**
 * Local dev entry: builds the dashboard, keeps rebuilding it on source changes,
 * and runs the daemon — all from one `bun run dev`. The daemon serves
 * dist/dashboard.html fresh on each request, so editing src/dashboard/* and
 * reloading the browser shows the change (no HMR, but no restart either).
 *
 * Args after `dev` are passed through to the daemon; defaults to `watch`
 * (`bun run dev` ⇒ `spootie watch`).
 */
import { watch } from "node:fs";
import { join } from "node:path";
import { buildDashboard } from "./build-dashboard.ts";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src", "dashboard");

// Build once up front so the daemon's `with { type: "file" }` import of
// dist/dashboard.html resolves before it loads.
await buildDashboard();

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

const args = process.argv.slice(2);
const daemon = Bun.spawn(
    ["bun", "run", join(ROOT, "src", "index.ts"), ...(args.length ? args : ["watch"])],
    {
        stdio: ["inherit", "inherit", "inherit"],
    },
);
process.on("SIGINT", () => daemon.kill());
process.on("SIGTERM", () => daemon.kill());
await daemon.exited;
