import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Item, withToken } from "./api.ts";
import { groupLabel } from "./format.ts";
import { BrandMark, Icons } from "./icons.tsx";
import { Tile } from "./tile.tsx";

type Filter = "all" | "pending" | "uploaded" | "queued";

const NAV_ITEMS: { key: Filter; label: string; icon: () => JSX.Element }[] = [
    { key: "all", label: "All drops", icon: Icons.grid },
    { key: "pending", label: "Pending approval", icon: Icons.clock },
    { key: "uploaded", label: "Uploaded", icon: Icons.uploaded },
    { key: "queued", label: "Queued", icon: Icons.queued },
];

const EMPTY_COPY: Record<Filter, string> = {
    all: "No drops yet — new captures appear here to approve.",
    pending: "Nothing pending — you're all caught up.",
    uploaded: "No uploads yet.",
    queued: "Nothing queued.",
};

// True only for a real file drag (not a text/link drag), so the drop overlay
// doesn't appear when dragging selected text around.
const isFileDrag = (e: DragEvent): boolean =>
    !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1;

export function App() {
    const [items, setItems] = useState<Item[] | null>(null); // null = first load
    const [online, setOnline] = useState(true);
    const [authFailed, setAuthFailed] = useState(false);
    const [filter, setFilter] = useState<Filter>("all");
    const [dragging, setDragging] = useState(false);
    const [uploadErr, setUploadErr] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepth = useRef(0);
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    // Suppress the browser default for a file dropped ANYWHERE on the page (e.g.
    // the sidebar) — otherwise the browser navigates to the file and blows the
    // dashboard away. The upload/overlay stay scoped to <main>.
    useEffect(() => {
        const prevent = (e: Event) => e.preventDefault();
        window.addEventListener("dragover", prevent);
        window.addEventListener("drop", prevent);
        return () => {
            window.removeEventListener("dragover", prevent);
            window.removeEventListener("drop", prevent);
        };
    }, []);

    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const res = await fetch(withToken("/api/items"), { cache: "no-store" });
                // 403 means the daemon is up but our token is missing/stale — a
                // distinct state from an unreachable daemon, with its own fix.
                if (res.status === 403) {
                    if (!alive) return;
                    setAuthFailed(true);
                    setOnline(true);
                    return;
                }
                if (!res.ok) throw new Error("bad status");
                const data = await res.json();
                if (!alive) return;
                setItems(Array.isArray(data.items) ? data.items : []);
                setAuthFailed(false);
                setOnline(true);
            } catch {
                if (!alive) return;
                setOnline(false); // keep whatever we last had
            }
        };
        tick();
        const iv = setInterval(tick, 2000);
        return () => {
            alive = false;
            clearInterval(iv);
        };
    }, []);

    const list = items || [];
    const counts: Record<Filter, number> = {
        all: list.length,
        pending: list.filter((it) => it.kind === "pending").length,
        uploaded: list.filter((it) => it.kind === "uploaded").length,
        queued: list.filter((it) => it.kind === "queued").length,
    };
    const visible = filter === "all" ? list : list.filter((it) => it.kind === filter);

    const onRemove = (kind: string, id: string) =>
        setItems((prev) => (prev || []).filter((x) => !(x.kind === kind && x.id === id)));

    // Uploads synthesise an "uploaded" item as soon as /api/upload responds, so
    // it appears instantly rather than waiting for the next poll; de-dupe by id
    // so the poll's copy (possibly with a thumbnail) simply replaces it.
    const onUploaded = (item: Item) =>
        setItems((prev) => [item, ...(prev || []).filter((x) => x.id !== item.id)]);

    // Files upload sequentially so the clipboard ends on the LAST file's URL
    // deterministically; the daemon already copies it server-side too.
    const uploadAll = async (fileList: FileList | null) => {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        setUploadErr("");
        let lastUrl = "";
        for (const file of files) {
            try {
                const fd = new FormData();
                // Field name must be "file" — the server reads form.get("file").
                fd.append("file", file);
                const res = await fetch(withToken("/api/upload"), { method: "POST", body: fd });
                if (!res.ok) {
                    let msg = "Upload failed";
                    try {
                        const j = await res.json();
                        if (j && j.error) msg = j.error;
                    } catch {}
                    throw new Error(msg);
                }
                const j = await res.json();
                if (j && j.url) lastUrl = j.url;
                if (j && j.key) {
                    onUploaded({
                        id: j.key,
                        kind: "uploaded",
                        fileName: file.name,
                        date: new Date().toISOString(),
                        url: j.url || null,
                        thumb: false,
                    });
                }
            } catch (e) {
                // Surface the failure and stop; files already uploaded remain.
                setUploadErr(
                    `Couldn't upload ${file.name}: ${(e as Error).message || "Upload failed"}`,
                );
                timers.current.push(setTimeout(() => setUploadErr(""), 6000));
                return;
            }
        }
        if (lastUrl) {
            try {
                await navigator.clipboard.writeText(lastUrl);
            } catch {}
        }
    };

    const openPicker = () => fileInputRef.current?.click();
    const onPick = (e: Event) => {
        const input = e.target as HTMLInputElement;
        uploadAll(input.files);
        input.value = "";
    };

    // The entire main area is a drop zone; track enter/leave depth so a drag
    // over a child element doesn't flicker the overlay off.
    const onDragEnter = (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
        if (isFileDrag(e)) e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        uploadAll(e.dataTransfer && e.dataTransfer.files);
    };

    // Group the already-sorted (newest-first) items under date headers.
    const groups: { label: string; items: Item[] }[] = [];
    for (const it of visible) {
        const label = groupLabel(it.date);
        let g = groups[groups.length - 1];
        if (!g || g.label !== label) {
            g = { label, items: [] };
            groups.push(g);
        }
        g.items.push(it);
    }

    return (
        <>
            <aside class="rail">
                <div class="brand">
                    <span class="brand-mark">
                        <BrandMark />
                        <span
                            class={"status-dot" + (authFailed || !online ? " off" : "")}
                            aria-hidden="true"
                        />
                    </span>
                    <span class="brand-word">Spootie</span>
                </div>

                <button class="rail-upload" type="button" onClick={openPicker}>
                    <Icons.upload /> Upload a file
                </button>
                <input ref={fileInputRef} type="file" multiple hidden onChange={onPick} />

                <nav class="nav">
                    {NAV_ITEMS.map((n) => (
                        <button
                            key={n.key}
                            class={"nav-item" + (filter === n.key ? " is-active" : "")}
                            type="button"
                            onClick={() => setFilter(n.key)}
                        >
                            <n.icon />
                            {n.label}
                            <span class="nav-count">{counts[n.key]}</span>
                        </button>
                    ))}
                </nav>

                <div class="rail-spacer" />

                <div class="rail-foot">
                    <p class="stat">
                        {counts.all} drop{counts.all === 1 ? "" : "s"}
                    </p>
                    <p>Links expire after 7 days</p>
                </div>
            </aside>

            <main
                class={"main" + (dragging ? " is-dragging" : "")}
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                <div class="toolbar">
                    <h1 class="page-title">Drops</h1>
                    {counts.pending > 0 && (
                        <button class="page-sub" type="button" onClick={() => setFilter("pending")}>
                            {counts.pending} waiting for your review
                        </button>
                    )}
                </div>

                <div class="content">
                    {authFailed ? (
                        <div class="banner">
                            Session expired — run <code>spootie ui</code> in your terminal to reopen
                            the dashboard.
                        </div>
                    ) : !online && items !== null ? (
                        <div class="banner">Can't reach the daemon — retrying every 2s…</div>
                    ) : null}
                    {uploadErr && <div class="banner err">{uploadErr}</div>}

                    {items === null ? null : visible.length === 0 ? (
                        <div class="empty">
                            <Icons.file />
                            <p>{EMPTY_COPY[filter]}</p>
                        </div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.label}>
                                <h2 class="date-heading">{g.label}</h2>
                                <div class="grid">
                                    {g.items.map((it) => (
                                        <Tile
                                            key={it.kind + ":" + it.id}
                                            item={it}
                                            onRemove={onRemove}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div class="drop-overlay" aria-hidden="true">
                    <div class="drop-overlay-label">
                        <Icons.dropArrow /> Drop to upload
                    </div>
                </div>
            </main>
        </>
    );
}
