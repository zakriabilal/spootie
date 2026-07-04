import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { PREACT_STANDALONE_ASSET, VARIANT_A_HTML_ASSET } from "./embedded-assets.ts";
import { errorMessage } from "./errors.ts";
import { readHistory, readLastUpload, removeFromHistory } from "./history.ts";
import type { UploadQueue } from "./queue.ts";
import { DATA_DIR, ensurePrivateDir, isPaused, setPaused } from "./state.ts";
import { deleteObject } from "./upload.ts";

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
 * items come from the live UploadQueue. The UI codes against this shape.
 */
export interface UiItem {
  /** History key (uploaded) or queue entry id (queued) — stable per kind. */
  id: string;
  kind: "uploaded" | "queued";
  fileName: string;
  /** ISO 8601 timestamp: uploadedAt (uploaded) or queuedAt (queued). */
  date: string;
  /** Public share URL for uploaded items; null while queued. */
  url: string | null;
}

/**
 * Only these exact paths are served as static files — there is no generic
 * filesystem serving, so no path-traversal surface. `path` is the resolved
 * embedded-asset path (see embedded-assets.ts): a real file under `bun run`,
 * or a $bunfs path in the compiled binary — Bun.file() reads both the same
 * way, so no dev/compiled branch is needed here.
 */
const STATIC_ROUTES: Record<string, { path: string; type: string }> = {
  "/": { path: VARIANT_A_HTML_ASSET, type: "text/html; charset=utf-8" },
  "/vendor/preact-standalone.mjs": {
    path: PREACT_STANDALONE_ASSET,
    type: "text/javascript; charset=utf-8",
  },
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

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

/** Merge history + live queue into one newest-first list of dashboard items. */
const buildItems = async (queue: UploadQueue): Promise<UiItem[]> => {
  const uploaded: UiItem[] = (await readHistory()).map((e) => ({
    id: e.key,
    kind: "uploaded",
    fileName: e.fileName,
    date: e.uploadedAt,
    url: e.url,
  }));

  const queued: UiItem[] = queue.list().map((e) => ({
    id: e.id,
    kind: "queued",
    fileName: e.filePath.split("/").pop() ?? e.filePath,
    date: e.queuedAt,
    url: null,
  }));

  return [...uploaded, ...queued].sort((a, b) => b.date.localeCompare(a.date));
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
  return json({ ok: true });
};

/**
 * Toggle the pause flag from the dashboard (or the menu bar app). Body is
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

const serveStatic = async (pathname: string): Promise<Response> => {
  const route = STATIC_ROUTES[pathname];
  if (route === undefined) return new Response("Not found", { status: 404 });
  const file = Bun.file(route.path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "content-type": route.type } });
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
  config,
}: {
  queue: UploadQueue;
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
        return json({ items: await buildItems(queue) });
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
      if (pathname === "/api/pause" && req.method === "POST") {
        if (!authed || !isAllowedOrigin(req.headers.get("origin"), boundPort)) {
          return new Response("Forbidden", { status: 403 });
        }
        return handlePause(req);
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
 * Read ui.json to locate a running daemon's dashboard. Returns null if the file
 * is missing, malformed, or names a server that no longer answers on its port
 * (a stale record left by a crash), so callers never advertise a dead server.
 */
export const readUiInfo = async (): Promise<UiInfo | null> => {
  try {
    const raw: unknown = await Bun.file(UI_INFO_PATH).json();
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { port?: unknown }).port === "number" &&
      typeof (raw as { pid?: unknown }).pid === "number" &&
      typeof (raw as { token?: unknown }).token === "string"
    ) {
      const info = raw as UiInfo;
      if (await isDaemonListening(info.port, info.token)) return info;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * The dashboard URL for a bound port. Include the token to produce the link a
 * browser can open; the page stashes it in sessionStorage and resends it as a
 * `token` query param on every API call.
 */
export const uiUrl = (port: number, token?: string): string =>
  `http://127.0.0.1:${port}/${token ? `?token=${token}` : ""}`;
