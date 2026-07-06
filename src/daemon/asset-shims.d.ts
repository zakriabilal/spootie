/**
 * Ambient module declarations for the `with { type: "file" }` embedding
 * imports in assets.ts. Bun resolves these to a runtime path string, but
 * bun-types' extension-based ambient declarations type them for a different
 * use case (*.html resolves to Bun's frontend-dev-server `HTMLBundle`, not a
 * plain path). Wildcard patterns (rather than exact specifiers) because
 * TypeScript matches ambient module declarations for relative imports by
 * pattern, the same way bun-types' own wildcard "bun.lock" declaration does.
 *
 * NOTE: deliberately not named "assets.d.ts" — TypeScript pairs a
 * same-basename .d.ts with its .ts sibling (as if it were the sibling's own
 * declaration file) and silently drops it from the program instead of
 * treating it as an ambient/global declarations file, which made every
 * `declare module` below invisible to the checker.
 */
declare module "*/dist/dashboard.html" {
    const path: string;
    export default path;
}

declare module "*/public/favicon.svg" {
    const path: string;
    export default path;
}
