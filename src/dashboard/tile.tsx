import { useEffect, useRef, useState } from "preact/hooks";
import { approveItem, copyText, deleteItem, discardItem, type Item, withToken } from "./api.ts";
import { fmtTime } from "./format.ts";
import { Icons } from "./icons.tsx";

interface TileProps {
    item: Item;
    onRemove: (kind: string, id: string) => void;
}

/**
 * One drop in the grid. Its actions depend on kind: uploaded gets Copy/Delete,
 * pending gets Approve/Discard, queued gets Cancel. All mutations are
 * optimistic — the row disappears immediately and the next 2s poll reconciles
 * with the server.
 */
export function Tile({ item, onRemove }: TileProps) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [copied, setCopied] = useState(false);
    const [thumbBroken, setThumbBroken] = useState(false);
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);
    const track = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

    const onCopy = async () => {
        const ok = await copyText(item.url || "");
        if (ok) {
            setCopied(true);
            track(() => setCopied(false), 1400);
        } else setErr("Couldn't copy");
    };
    // Run a tile mutation: mark busy, call the API, optimistically drop the row
    // on success, or re-enable and surface the error on failure.
    const runAction = async (call: () => Promise<void>, kind: string, fallbackMsg: string) => {
        setBusy(true);
        setErr("");
        try {
            await call();
            onRemove(kind, item.id);
        } catch (e) {
            setBusy(false);
            setErr((e as Error).message || fallbackMsg);
        }
    };
    const onDelete = () =>
        runAction(() => deleteItem("uploaded", item.id), "uploaded", "Delete failed");
    const onApprove = () => runAction(() => approveItem(item.id), "pending", "Approve failed");
    const onDiscard = () => runAction(() => discardItem(item.id), "pending", "Discard failed");
    const onCancel = () =>
        runAction(() => deleteItem("queued", item.id), "queued", "Cancel failed");

    // Thumbnails are local-only; <img> can't send headers, so the token rides
    // the query string like every other API call.
    const thumbSrc =
        item.thumb && !thumbBroken
            ? withToken("/api/thumb?key=" + encodeURIComponent(item.id))
            : null;
    const timeLabel = err ? err : item.kind === "queued" ? "Retrying…" : fmtTime(item.date);

    return (
        <article class={"tile" + (item.kind === "pending" ? " is-pending" : "")}>
            {item.kind === "pending" && <span class="ring" aria-hidden="true" />}
            {item.kind === "queued" && (
                <span class="queued-mark" aria-hidden="true">
                    <span class="spin" />
                </span>
            )}
            {thumbSrc ? (
                <img
                    class="shot"
                    loading="lazy"
                    alt=""
                    src={thumbSrc}
                    onError={() => setThumbBroken(true)}
                />
            ) : (
                <span class="tile-ph" aria-hidden="true">
                    <Icons.file />
                </span>
            )}
            <div class="tile-info">
                <div class="tile-meta">
                    <span class="tile-name" title={item.fileName}>
                        {item.fileName}
                    </span>
                </div>
                <div class="tile-meta">
                    <span class={"tile-time" + (err ? " err" : "")}>{timeLabel}</span>
                    <span class="tile-actions">
                        {item.kind === "uploaded" && (
                            <>
                                <button
                                    class={"ibtn" + (copied ? " is-copied" : "")}
                                    type="button"
                                    aria-label="Copy link"
                                    onClick={onCopy}
                                >
                                    {copied ? <Icons.check /> : <Icons.copy />}
                                </button>
                                <button
                                    class="ibtn discard"
                                    type="button"
                                    aria-label="Delete"
                                    disabled={busy}
                                    onClick={onDelete}
                                >
                                    <Icons.trash />
                                </button>
                            </>
                        )}
                        {item.kind === "pending" && (
                            <>
                                <button
                                    class="ibtn approve"
                                    type="button"
                                    aria-label="Approve"
                                    disabled={busy}
                                    onClick={onApprove}
                                >
                                    <Icons.check />
                                </button>
                                <button
                                    class="ibtn discard"
                                    type="button"
                                    aria-label="Discard"
                                    disabled={busy}
                                    onClick={onDiscard}
                                >
                                    <Icons.x />
                                </button>
                            </>
                        )}
                        {item.kind === "queued" && (
                            <button
                                class="ibtn discard"
                                type="button"
                                aria-label="Cancel"
                                disabled={busy}
                                onClick={onCancel}
                            >
                                <Icons.x />
                            </button>
                        )}
                    </span>
                </div>
            </div>
        </article>
    );
}
