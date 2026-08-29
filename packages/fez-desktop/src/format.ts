/** "1.2K" / "3.4M" — also correct past a billion, which the old hand-rolls weren't. */
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const compact = (n: number): string => compactFmt.format(n);

/** Local-calendar "YYYY-MM-DD" bucket key (en-CA is the ISO-ordered locale). */
export const dayKey = (ts: number): string => new Date(ts).toLocaleDateString("en-CA");
