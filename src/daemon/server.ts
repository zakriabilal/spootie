import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyUrlBestEffort } from "../lib/clipboard.ts";
import type { Config } from "../lib/config.ts";
import { DASHBOARD_HTML_ASSET, FAVICON_SVG_ASSET, PREACT_STANDALONE_ASSET } from "./assets.ts";
import { errorMessage, errorStatus, isRetryableNetworkError } from "../lib/errors.ts";
import {
    readHistory,
    readLastUpload,
    recordUpload,
    removeFromHistory,
    removeManyFromHistory,
} from "../lib/history.ts";
import type { PendingStore } from "./pending.ts";
import type { UploadQueue } from "./queue.ts";
import { DATA_DIR, ensurePrivateDir, isPaused, setPaused } from "../lib/state.ts";
import {
    deleteThumbnail,
    generateThumbnail,
    generateThumbnailFromBytes,
    thumbPathForKey,
} from "./thumbs.ts";
import {
    contentDispositionAttachment,
    deleteObject,
    deleteObjects,
    generateKey,
    uploadBytes,
    uploadFile,
} from "../lib/upload.ts";

/**
 * Largest multipart body the dashboard upload route accepts (512 MB), set as
 * Bun.serve's maxRequestBodySize below. Big enough for a video drop, bounded so
 * a single request can't exhaust memory buffering the body.
 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** Where the running daemon advertises its dashboard port to the CLI. */
export const UI_INFO_PATH = join(DATA_DIR, "ui.json");

/** Written to ui.json so `spootie status`/`spootie ui` can find the server. */
export interface UiInfo {
    port: number;
    /** PID of the daemon that owns this server, for a liveness check. */
    pid: number;
    /**
     * Random secret gating the API. ui.json is 0600, so only the owner can read
     * it; the dashboard receives it via the URL `spootie ui` opens, keeps a copy
     * in the tab's sessionStorage, and resends it as a `token` query param on
     * every API request. We deliberately avoid a cookie: cookies can't be
     * port-scoped, so a cookie would leak this token to every other server on
     * 127.0.0.1. Another local user's process cannot read it and so cannot list
     * share URLs or delete uploads over the loopback port.
     */
    token: string;
}

/**
 * A single dashboard item. Uploaded items come from the history file; queued
 * items come from the live UploadQueue; pending items come from the live
 * PendingStore (detected screenshots awaiting approve/discard). The UI codes
 * against this shape.
 */
export interface UiItem {
    /**
     * History key (uploaded), queue entry id (queued), or pending entry id
     * (pending) — stable per kind.
     */
    id: string;
    kind: "uploaded" | "queued" | "pending";
    fileName: string;
    /**
     * ISO 8601 timestamp: uploadedAt (uploaded), queuedAt (queued), or
     * detectedAt (pending).
     */
    date: string;
    /** Public share URL for uploaded items; null while queued or pending. */
    url: string | null;
    /**
     * True if a local thumbnail exists for this item (served by /api/thumb).
     * Always false for queued items — they have not been uploaded yet.
     */
    thumb: boolean;
}

/**
 * Only these exact paths are served as static files — there is no generic
 * filesystem serving, so no path-traversal surface. `path` is the resolved
 * embedded-asset path (see assets.ts): a real file under `bun run`,
 * or a $bunfs path in the compiled binary — Bun.file() reads both the same
 * way, so no dev/compiled branch is needed here.
 */
const STATIC_ROUTES: Record<string, { path: string; type: string; cache?: string }> = {
    "/": { path: DASHBOARD_HTML_ASSET, type: "text/html; charset=utf-8" },
    "/vendor/preact-standalone.mjs": {
        path: PREACT_STANDALONE_ASSET,
        type: "text/javascript; charset=utf-8",
    },
    // The favicon never changes at a given path and carries no secrets, so let the
    // browser cache it hard rather than re-fetch it on every dashboard visit.
    "/favicon.svg": {
        path: FAVICON_SVG_ASSET,
        type: "image/svg+xml",
        cache: "public, max-age=31536000, immutable",
    },
};

const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });

/**
 * Parse a JSON request body and pull a string `id` out of it. Returns the id on
 * success, or a ready-to-return 400 Response if the body is unparseable or lacks
 * a string `id`. Shared by the pending approve/discard endpoints.
 */
const readIdBody = async (req: Request): Promise<string | Response> => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return json({ error: "Invalid JSON body" }, 400);
    }
    const { id } = (body ?? {}) as { id?: unknown };
    if (typeof id !== "string") return json({ error: "Expected { id: string }" }, 400);
    return id;
};

/**
 * Reject any request whose Host header is not our own loopback address. This is
 * the standard DNS-rebinding defence: binding to 127.0.0.1 does not stop a
 * malicious page that has rebound its domain to 127.0.0.1, but such a request
 * still carries the attacker's Host, not `127.0.0.1:<port>`.
 */
const isAllowedHost = (host: string | null, port: number): boolean =>
    host === `127.0.0.1:${port}` || host === `localhost:${port}`;

/**
 * Reject state-changing requests carrying a foreign Origin. A cross-site
 * "simple" POST (text/plain body, no preflight) still sends the attacker's
 * Origin, so this closes the CSRF path that the Host check alone cannot.
 */
const isAllowedOrigin = (origin: string | null, port: number): boolean =>
    origin === null ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`;

/** Merge history + live queue + live pending into one newest-first list. */
const buildItems = async (queue: UploadQueue, pending: PendingStore): Promise<UiItem[]> => {
    const uploaded: UiItem[] = (await readHistory()).map((e) => ({
        id: e.key,
        kind: "uploaded",
        fileName: e.fileName,
        date: e.uploadedAt,
        url: e.url,
        thumb: e.thumb === true,
    }));

    const queued: UiItem[] = queue.list().map((e) => ({
        id: e.id,
        kind: "queued",
        fileName: e.filePath.split("/").pop() ?? e.filePath,
        date: e.queuedAt,
        url: null,
        thumb: false,
    }));

    const pendingItems: UiItem[] = pending.list().map((e) => ({
        id: e.id,
        kind: "pending",
        fileName: e.fileName,
        date: e.detectedAt,
        url: null,
        thumb: e.thumb === true,
    }));

    return [...uploaded, ...queued, ...pendingItems].toSorted((a, b) =>
        b.date.localeCompare(a.date),
    );
};

const handleDelete = async (
    req: Request,
    queue: UploadQueue,
    config: Config,
): Promise<Response> => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return json({ error: "Invalid JSON body" }, 400);
    }

    const { kind, id } = (body ?? {}) as { kind?: unknown; id?: unknown };
    if (typeof id !== "string" || (kind !== "uploaded" && kind !== "queued")) {
        return json({ error: "Expected { kind: 'uploaded'|'queued', id: string }" }, 400);
    }

    if (kind === "queued") {
        const cancelled = await queue.cancel(id);
        if (!cancelled) return json({ error: "No such queued item" }, 404);
        return json({ ok: true });
    }

    // Uploaded: only ever delete a key we actually recorded — never trust the
    // request to name an arbitrary object in the bucket.
    const entry = (await readHistory()).find((e) => e.key === id);
    if (entry === undefined) return json({ error: "No such uploaded item" }, 404);
    try {
        await deleteObject(entry.key, config);
    } catch (err) {
        return json({ error: `Could not delete from R2: ${errorMessage(err)}` }, 502);
    }
    await removeFromHistory(entry.key);
    // Best-effort: drop the local thumbnail too so it doesn't linger orphaned.
    await deleteThumbnail(entry.key);
    return json({ ok: true });
};

/** Largest batch /api/delete-batch accepts, matching S3's DeleteObjects cap. */
const MAX_DELETE_BATCH = 1000;

/**
 * Delete many items at once from the dashboard — the multi-select "Delete
 * selected" action and "Empty all" both post here (Empty all is just a batch of
 * every item id, so the server stays generic). Token + Origin gated by the
 * caller exactly like {@link handleDelete}.
 *
 * The UI sends item ids in `keys`. An id is either a queue entry's UUID (a queued
 * item, cancelled via {@link UploadQueue.cancel}) or an R2 object key (an
 * uploaded item). We distinguish the same way handleDelete does — a queued id is
 * never an R2 key — and, mirroring handleDelete's safety rule, only ever delete
 * an uploaded key we actually recorded, never an arbitrary bucket object named by
 * the request. Uploaded keys are removed with the batched
 * {@link deleteObjects} call rather than N sequential deletes.
 *
 * Reporting is honest and per-key: `{ ok, deleted, failed }`. A key whose R2
 * delete failed is left in history so it stays visible and retryable. Status is
 * 200 when everything succeeded, 502 when everything failed, and 207 for a
 * partial success (still a JSON body the UI reads either way).
 */
const handleDeleteBatch = async (
    req: Request,
    queue: UploadQueue,
    config: Config,
): Promise<Response> => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return json({ error: "Invalid JSON body" }, 400);
    }

    const { keys } = (body ?? {}) as { keys?: unknown };
    if (
        !Array.isArray(keys) ||
        keys.length === 0 ||
        keys.length > MAX_DELETE_BATCH ||
        !keys.every((k) => typeof k === "string")
    ) {
        return json(
            { error: `Expected { keys: string[] } with 1–${MAX_DELETE_BATCH} entries` },
            400,
        );
    }

    const deleted: string[] = [];
    const failed: { key: string; error: string }[] = [];

    // De-dupe so a repeated id can't be counted or deleted twice.
    const ids = [...new Set(keys as string[])];

    // Partition into queued ids (cancel) and recorded uploaded keys (R2 delete).
    // Anything matching neither is reported failed rather than silently ignored.
    const queuedIds = new Set(queue.list().map((e) => e.id));
    const historyKeys = new Set((await readHistory()).map((e) => e.key));

    const uploadedKeys: string[] = [];
    for (const id of ids) {
        if (queuedIds.has(id)) {
            const cancelled = await queue.cancel(id);
            if (cancelled) deleted.push(id);
            else failed.push({ key: id, error: "No such queued item" });
        } else if (historyKeys.has(id)) {
            uploadedKeys.push(id);
        } else {
            failed.push({ key: id, error: "No such item" });
        }
    }

    if (uploadedKeys.length > 0) {
        const res = await deleteObjects(uploadedKeys, config);
        deleted.push(...res.deleted);
        failed.push(...res.failed);
        // Only forget keys R2 confirmed gone; a failed key stays in history so the
        // user can still see and retry it. One atomic history write for the batch.
        await removeManyFromHistory(res.deleted);
        // Best-effort: drop each deleted item's local thumbnail so none linger.
        for (const key of res.deleted) await deleteThumbnail(key);
    }

    const ok = failed.length === 0;
    const status = ok ? 200 : deleted.length === 0 ? 502 : 207;
    return json({ ok, deleted, failed }, status);
};

/**
 * Toggle the pause flag from the dashboard. Body is
 * validated strictly, like handleDelete, since it drives a state change.
 */
const handlePause = async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return json({ error: "Invalid JSON body" }, 400);
    }

    const { paused } = (body ?? {}) as { paused?: unknown };
    if (typeof paused !== "boolean") {
        return json({ error: "Expected { paused: boolean }" }, 400);
    }

    await setPaused(paused);
    return json({ ok: true, paused });
};

/**
 * Upload a single dropped file to R2 from the dashboard drop zone. Accepts one
 * `multipart/form-data` body with a single `file` field (the UI sends several
 * files as sequential requests). Like handleDelete/handlePause this is a
 * mutation, so the caller has already enforced the token + Origin checks.
 *
 * On success: records the upload in history under its ORIGINAL name, copies the
 * share URL to the clipboard (best-effort — never fails the request), kicks off
 * a detached local thumbnail for images, and returns { ok, url, key }. A failed
 * R2 upload records nothing and maps to 413 (too large, if the error says so) or
 * 502, mirroring handleDelete's mapping.
 */
const handleUpload = async (req: Request, config: Config): Promise<Response> => {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
        return json({ error: "Expected multipart/form-data" }, 400);
    }

    // Infer the exact FormData type from req.formData() — annotating it as the
    // global FormData resolves to a conflicting type under our @types setup.
    const form = await req.formData().catch(() => null);
    if (form === null) {
        return json({ error: "Could not parse multipart form body" }, 400);
    }

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
        return json({ error: "Expected a non-empty 'file' field" }, 400);
    }

    const fileName = file.name.trim() === "" ? "download" : file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const key = generateKey(fileName);
    // Trust the browser's type but never send an empty ContentType to R2.
    const uploadType = file.type.trim() === "" ? "application/octet-stream" : file.type;
    const disposition = contentDispositionAttachment(fileName);

    let url: string;
    try {
        ({ url } = await uploadBytes(bytes, key, uploadType, disposition, config));
    } catch (err) {
        // Nothing was recorded, so there is no half-written history entry to undo.
        if (errorStatus(err) === 413) {
            return json({ error: "File is too large for the bucket" }, 413);
        }
        return json({ error: `Could not upload to R2: ${errorMessage(err)}` }, 502);
    }

    // Only reached on a successful upload: record it, then best-effort copy.
    await recordUpload({
        key,
        url,
        fileName,
        uploadedAt: new Date().toISOString(),
    });
    // Best-effort clipboard copy — keep a stray pbcopy failure (e.g. no
    // clipboard) from turning a good upload into a 502.
    await copyUrlBestEffort(url);
    // Local-only preview; detached so it never delays the response, and it owns
    // its temp file's lifecycle (write -> thumb -> unlink) internally.
    generateThumbnailFromBytes(key, fileName, bytes);

    return json({ ok: true, url, key });
};

/**
 * Approve a pending screenshot: upload it to R2 and move it into history. The
 * pending entry's local thumbnail (rendered while it sat pending) already
 * lives under its id, so a fresh upload thumbnail is generated under the new
 * R2 key rather than reused.
 *
 *  - success            -> 200 { ok: true, url, key }; entry leaves pending.
 *  - network error      -> 200 { ok: true, queued: true }; entry moves into
 *                          the retry queue and leaves pending.
 *  - file gone on disk  -> 404 { error }; entry removed from pending.
 *  - too large          -> 413 { error }; entry kept in pending.
 *  - other upload error -> 502 { error }; entry kept in pending.
 *  - unknown id         -> 404 { error }.
 */
const handleApprove = async (
    req: Request,
    queue: UploadQueue,
    pending: PendingStore,
    config: Config,
): Promise<Response> => {
    const id = await readIdBody(req);
    if (id instanceof Response) return id;

    const entry = pending.get(id);
    if (entry === undefined) return json({ error: "No such pending item" }, 404);

    if (!(await Bun.file(entry.filePath).exists())) {
        await pending.discard(id);
        return json({ error: "That screenshot is no longer on disk." }, 404);
    }

    try {
        const { url, key } = await uploadFile(entry.filePath, config);
        await recordUpload({
            key,
            url,
            fileName: entry.fileName,
            uploadedAt: new Date().toISOString(),
        });
        // Local-only preview; fire-and-forget so it never delays the response.
        generateThumbnail(key, entry.filePath);
        // Best-effort clipboard copy — never fail the request over it.
        await copyUrlBestEffort(url);
        await pending.discard(id);
        return json({ ok: true, url, key });
    } catch (err) {
        if (isRetryableNetworkError(err)) {
            await queue.enqueue(entry.filePath);
            await pending.discard(id);
            return json({ ok: true, queued: true });
        }
        const status = errorStatus(err) === 413 ? 413 : 502;
        return json({ error: `Could not upload to R2: ${errorMessage(err)}` }, status);
    }
};

/** Discard a pending screenshot without uploading it. */
const handleDiscard = async (req: Request, pending: PendingStore): Promise<Response> => {
    const id = await readIdBody(req);
    if (id instanceof Response) return id;

    const discarded = await pending.discard(id);
    if (!discarded) return json({ error: "No such pending item" }, 404);
    return json({ ok: true });
};

/**
 * Serve a local thumbnail by object key. The key arrives as a query param (an
 * <img src> can't send an auth header, so the token rides the query string like
 * everything else). thumbPathForKey rejects any key with a separator, a `..`, or
 * a character outside the base64url+extension set and confirms the resolved path
 * sits inside the thumbs dir, so a hostile key (`../../etc/passwd`, `a/b.jpg`,
 * `%2e%2e%2f` once URL-decoded) yields a 404 rather than a traversal. Thumbnails
 * are immutable per key (the key is a random id), so they cache hard — the 2s
 * dashboard poll won't re-fetch them.
 */
const serveThumb = async (key: string | null): Promise<Response> => {
    if (key === null) return new Response("Not found", { status: 404 });
    const path = thumbPathForKey(key);
    if (path === null) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
        headers: {
            "content-type": "image/jpeg",
            "cache-control": "private, max-age=31536000, immutable",
        },
    });
};

const serveStatic = async (pathname: string): Promise<Response> => {
    const route = STATIC_ROUTES[pathname];
    if (route === undefined) return new Response("Not found", { status: 404 });
    const file = Bun.file(route.path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    const headers: Record<string, string> = { "content-type": route.type };
    if (route.cache !== undefined) headers["cache-control"] = route.cache;
    return new Response(file, { headers });
};

/** Raised when another live daemon already owns ui.json. */
export class AlreadyRunningError extends Error {
    constructor(url: string) {
        super(
            `spootie is already running (dashboard at ${url}). Stop that instance ` +
                "first — running two watchers would prompt for every screenshot twice.",
        );
        this.name = "AlreadyRunningError";
    }
}

/**
 * Start the local dashboard server inside the daemon process. Binds strictly
 * to 127.0.0.1 on a random unused port, advertises the port via ui.json, and
 * returns a stop() that shuts the server down and removes ui.json.
 *
 * Refuses to start if a live daemon already owns ui.json, so a second instance
 * can never clobber the running one's advertised dashboard (or double-prompt).
 */
export const startUiServer = async ({
    queue,
    pending,
    config,
}: {
    queue: UploadQueue;
    pending: PendingStore;
    config: Config;
}): Promise<{ port: number; token: string; stop: () => void }> => {
    const existing = await readUiInfo();
    if (existing !== null && existing.pid !== process.pid) {
        throw new AlreadyRunningError(uiUrl(existing.port, existing.token));
    }

    // Secret the dashboard must present to reach the API. 192 bits of entropy,
    // URL/cookie-safe.
    const token = randomBytes(24).toString("base64url");

    // Set once the server has bound; the fetch handler only runs afterwards.
    let boundPort = 0;

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        // Bound the drop-zone upload body deliberately; the default is far
        // smaller than a large file drop, which would otherwise be truncated.
        maxRequestBodySize: MAX_UPLOAD_BYTES,
        async fetch(req) {
            if (!isAllowedHost(req.headers.get("host"), boundPort)) {
                return new Response("Forbidden", { status: 403 });
            }

            const url = new URL(req.url);
            const { pathname } = url;

            // The dashboard authenticates with the token, supplied as a `token` query
            // param on every API request (from the URL `spootie ui` opens, which the
            // dashboard stashes in sessionStorage). We do not set a cookie — cookies
            // can't be port-scoped and would leak the token to other 127.0.0.1
            // servers. Any other local user's process lacks it, so it cannot touch
            // the API.
            const queryToken = url.searchParams.get("token");
            const authed = queryToken === token;

            if (pathname === "/api/items" && req.method === "GET") {
                if (!authed) return new Response("Forbidden", { status: 403 });
                return json({ items: await buildItems(queue, pending) });
            }
            if (pathname === "/api/thumb" && req.method === "GET") {
                if (!authed) return new Response("Forbidden", { status: 403 });
                return serveThumb(url.searchParams.get("key"));
            }
            if (pathname === "/api/status" && req.method === "GET") {
                if (!authed) return new Response("Forbidden", { status: 403 });
                const lastUpload = await readLastUpload();
                return json({
                    paused: await isPaused(),
                    queueLength: queue.list().length,
                    lastUpload: lastUpload
                        ? { url: lastUpload.url, uploadedAt: lastUpload.uploadedAt }
                        : null,
                });
            }
            if (pathname === "/api/delete" && req.method === "POST") {
                if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
                    return new Response("Forbidden", { status: 403 });
                }
                return handleDelete(req, queue, config);
            }
            if (pathname === "/api/delete-batch" && req.method === "POST") {
                if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
                    return new Response("Forbidden", { status: 403 });
                }
                return handleDeleteBatch(req, queue, config);
            }
            if (pathname === "/api/pause" && req.method === "POST") {
                if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
                    return new Response("Forbidden", { status: 403 });
                }
                return handlePause(req);
            }
            if (pathname === "/api/upload" && req.method === "POST") {
                if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
                    return new Response("Forbidden", { status: 403 });
                }
                return handleUpload(req, config);
            }
            if (pathname === "/api/approve" && req.method === "POST") {
                if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
                    return new Response("Forbidden", { status: 403 });
                }
                return handleApprove(req, queue, pending, config);
            }
            if (pathname === "/api/discard" && req.method === "POST") {
                if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
                    return new Response("Forbidden", { status: 403 });
                }
                return handleDiscard(req, pending);
            }
            if (req.method === "GET") {
                // Static pages carry no secrets; the dashboard reads its token from the
                // URL/sessionStorage and sends it on the API calls above.
                return serveStatic(pathname);
            }
            return new Response("Not found", { status: 404 });
        },
    });

    const { port } = server;
    if (port === undefined) {
        server.stop(true);
        throw new Error("UI server did not bind to a port");
    }
    boundPort = port;

    const info: UiInfo = { port, pid: process.pid, token };
    // ui.json holds the API token; keep it readable only by the owner.
    await ensurePrivateDir(DATA_DIR);
    await writeFile(UI_INFO_PATH, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    await chmod(UI_INFO_PATH, 0o600);

    const stop = (): void => {
        // Only remove ui.json if it still describes *this* instance — a second
        // `spootie watch` may have overwritten it, and we must not orphan the
        // still-running daemon's advertised dashboard. Synchronous so it completes
        // before the process exits.
        try {
            const raw = JSON.parse(readFileSync(UI_INFO_PATH, "utf8")) as { pid?: unknown };
            if (raw.pid === process.pid) unlinkSync(UI_INFO_PATH);
        } catch {
            // Best-effort.
        }
        server.stop(true);
    };

    return { port, token, stop };
};

/**
 * True if a live spootie dashboard is answering on `port` with our `token`.
 * Probing the recorded port is a direct liveness check: unlike matching the
 * daemon's `ps` command line, it isn't fooled by how the daemon was launched
 * (`bun … index.ts watch`, a linked `spootie` bin, …), and a stale ui.json left
 * by a crash — or one naming a pid a reboot has since reused — fails the probe
 * because nothing is listening there with our token. The URL host is our own
 * loopback address, so the auto Host header satisfies isAllowedHost.
 */
const isDaemonListening = async (port: number, token: string): Promise<boolean> => {
    try {
        const res = await fetch(
            `http://127.0.0.1:${port}/api/items?token=${encodeURIComponent(token)}`,
        );
        return res.ok;
    } catch {
        return false;
    }
};

/**
 * Read and validate ui.json WITHOUT probing the port. Returns the recorded
 * {@link UiInfo} — which may name a daemon that has since died — or null if the
 * file is missing or malformed. `spootie status` uses this together with a pid
 * liveness check to tell a live daemon apart from a stale record left by a
 * crash; {@link readUiInfo} layers the network probe on top for callers that
 * need a URL they can actually open.
 */
export const readUiInfoRaw = async (): Promise<UiInfo | null> => {
    try {
        const raw: unknown = await Bun.file(UI_INFO_PATH).json();
        if (
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { port?: unknown }).port === "number" &&
            typeof (raw as { pid?: unknown }).pid === "number" &&
            typeof (raw as { token?: unknown }).token === "string"
        ) {
            return raw as UiInfo;
        }
        return null;
    } catch {
        return null;
    }
};

/**
 * Read ui.json to locate a running daemon's dashboard. Returns null if the file
 * is missing, malformed, or names a server that no longer answers on its port
 * (a stale record left by a crash), so callers never advertise a dead server.
 */
export const readUiInfo = async (): Promise<UiInfo | null> => {
    const info = await readUiInfoRaw();
    if (info !== null && (await isDaemonListening(info.port, info.token))) return info;
    return null;
};

/**
 * The dashboard URL for a bound port. Include the token to produce the link a
 * browser can open; the page stashes it in sessionStorage and resends it as a
 * `token` query param on every API call.
 */
export const uiUrl = (port: number, token?: string): string =>
    `http://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`;
