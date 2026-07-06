/** Date/time formatting shared by the dashboard grid. */

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** "Today" / "Yesterday" / "28 June 2026" for a date-group header. */
export const groupLabel = (iso: string): string => {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return "Unknown date";
    const diff = Math.round(
        (startOfDay(new Date()).getTime() - startOfDay(dt).getTime()) / 86400000,
    );
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return dt.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

/** 24-hour HH:MM for a tile's timestamp. */
export const fmtTime = (iso: string): string => {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return "--:--";
    return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};
