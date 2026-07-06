/** API client for the dashboard: token handling, fetch helpers, and mutations. */

/** One drop in the grid, as returned by /api/items. */
export interface Item {
    id: string;
    kind: "pending" | "uploaded" | "queued";
    fileName: string;
    date: string;
    url: string | null;
    thumb: boolean;
}

// The API token comes from the URL `spootie ui` opens; keep it in this tab's
// sessionStorage and resend it as a `token` query param on every API call.
// (No cookie: cookies can't be port-scoped and would leak it to other
// 127.0.0.1 servers.)
export const TOKEN: string = (() => {
    const fromUrl = new URL(location.href).searchParams.get("token");
    try {
        if (fromUrl) {
            sessionStorage.setItem("spootie_token", fromUrl);
            return fromUrl;
        }
        return sessionStorage.getItem("spootie_token") || "";
    } catch {
        return fromUrl || "";
    }
})();

export const withToken = (path: string): string =>
    path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);

/**
 * Copy text via the Clipboard API. The dashboard is only served over loopback
 * (a secure context), so writeText is always available; return false only if
 * it rejects.
 */
export const copyText = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
};

/**
 * POST a JSON body to an /api mutation and throw the server's error message
 * (falling back to `fallbackMsg`) on any non-2xx response.
 */
const postAction = async (path: string, body: unknown, fallbackMsg: string): Promise<void> => {
    const res = await fetch(withToken(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        let msg = fallbackMsg;
        try {
            const j = await res.json();
            if (j && j.error) msg = j.error;
        } catch {}
        throw new Error(msg);
    }
};

export const deleteItem = (kind: string, id: string): Promise<void> =>
    postAction("/api/delete", { kind, id }, "Delete failed");
/** Approve a pending screenshot: uploads it to R2 (or queues it on a network error). */
export const approveItem = (id: string): Promise<void> =>
    postAction("/api/approve", { id }, "Approve failed");
/** Discard a pending screenshot without uploading it. */
export const discardItem = (id: string): Promise<void> =>
    postAction("/api/discard", { id }, "Discard failed");
