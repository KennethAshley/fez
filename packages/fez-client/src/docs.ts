import type { DocCommentReply, DocCommentThread, WireEvent } from "./index.js";

export interface DocAnchor { text: string; prefix: string; suffix: string }

/** Quote and nearby text survive edits above a selection without trusting stale offsets. */
export function createDocAnchor(content: string, start: number, end: number): DocAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) {
    throw new Error("Select a nonempty range inside the document.");
  }
  return { text: content.slice(start, end), prefix: content.slice(Math.max(0, start - 64), start), suffix: content.slice(end, end + 64) };
}

/** Relocate a quote, or its replacement between unique contexts; never guess a different occurrence. */
export function locateDocAnchor(content: string, anchor: DocAnchor): { start: number; end: number } | undefined {
  if (!anchor.text) return undefined;
  const matches: number[] = [];
  for (let start = content.indexOf(anchor.text); start !== -1; start = content.indexOf(anchor.text, start + 1)) matches.push(start);
  const contextual = matches.filter(start => content.slice(0, start).endsWith(anchor.prefix) && content.slice(start + anchor.text.length).startsWith(anchor.suffix));
  if (contextual.length === 1) return { start: contextual[0], end: contextual[0] + anchor.text.length };
  if (!anchor.prefix || !anchor.suffix) return undefined;
  const prefix = content.indexOf(anchor.prefix), suffix = content.indexOf(anchor.suffix);
  if (prefix < 0 || suffix < 0 || content.indexOf(anchor.prefix, prefix + 1) >= 0 || content.indexOf(anchor.suffix, suffix + 1) >= 0) return undefined;
  const start = prefix + anchor.prefix.length;
  return suffix > start ? { start, end: suffix } : undefined;
}

export function assertDocBase(latest: { id: string } | undefined, baseId: string | undefined): void {
  if (latest?.id !== baseId) throw new Error("Document version changed. Read the latest version before saving; your draft has not been published.");
}

function parseAnchor(value: string | undefined): DocAnchor | undefined {
  try {
    const anchor: unknown = JSON.parse(value ?? "");
    if (typeof anchor !== "object" || anchor === null || !("text" in anchor) || !("prefix" in anchor) || !("suffix" in anchor)) return;
    if (typeof anchor.text === "string" && typeof anchor.prefix === "string" && typeof anchor.suffix === "string") {
      return { text: anchor.text, prefix: anchor.prefix, suffix: anchor.suffix };
    }
  } catch { /* Legacy and malformed metadata remain whole-document comments. */ }
}

/** One thread fold for desktop and agent tools. Callers apply workspace membership first. */
export function docCommentThreads(events: WireEvent[], scope: { channelId?: string; slug?: string }): DocCommentThread[] {
  const scoped = [...new Map(events.map(event => [event.id, event])).values()].filter(event => {
    const slug = event.tags.find(t => t[0] === "d")?.[1];
    return scope.slug ? slug === scope.slug : !event.tags.some(t => t[0] === "d") && event.tags.some(t => t[0] === "h" && t[1] === scope.channelId);
  }).sort((a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id));
  const reply = (event: WireEvent): DocCommentReply => ({
    id: event.id, authorPk: event.pubkey, text: event.content, ts: event.created_at,
    mentionPks: event.tags.filter(t => t[0] === "p").map(t => t[1]),
  });
  const roots = new Map<string, DocCommentThread>();
  for (const event of scoped) {
    if (event.tags.some(t => t[0] === "e")) continue;
    const writer = event.tags.find(t => t[0] === "writer")?.[1];
    roots.set(event.id, {
      ...reply(event), anchor: event.tags.find(t => t[0] === "anchor")?.[1] ?? "",
      anchorContext: parseAnchor(event.tags.find(t => t[0] === "anchor-context")?.[1]),
      writerPk: writer && /^[a-f0-9]{64}$/.test(writer) ? writer : undefined,
      resolved: false, replies: [],
    });
  }
  for (const event of scoped) {
    const root = roots.get(event.tags.find(t => t[0] === "e")?.[1] ?? "");
    if (!root) continue;
    const resolved = event.tags.find(t => t[0] === "resolved")?.[1];
    if (resolved === "1" || resolved === "0") root.resolved = resolved === "1";
    if (event.content.trim()) root.replies.push(reply(event));
  }
  return [...roots.values()];
}

/** [[Page Name]] → "page-name" — one slug rule everywhere (GUI, mcp, TUI). */
export function wikiSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-");
}

/**
 * Put a document's versions in order, oldest first — with the guarantee
 * that the LAST one is genuinely current.
 *
 * Sorting by timestamp is not enough. Every version carries a `base`
 * tag naming the version it was written on top of, and edits made in
 * quick succession — an agent moving two cards, a fast pair of drags on
 * a board — land in the same second. Two versions then tie, and which
 * one a reader calls "latest" comes down to the order a relay happened
 * to return them. The next edit bases itself on that answer, so the
 * loser's change silently disappears.
 *
 * The base chain says what came after what without consulting a clock:
 * the current version is the one nothing else was written on top of.
 * Timestamps only break ties between genuinely concurrent branches —
 * two people who edited the same base, where somebody's edit has to
 * lose and the version list is there to show them it happened.
 */
export function orderVersions<T extends { id: string; created_at: number; tags: string[][] }>(events: T[]): T[] {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1));
  if (sorted.length < 2) return sorted;
  const superseded = new Set(
    events.map((event) => event.tags.find((t) => t[0] === "base")?.[1]).filter((id): id is string => !!id)
  );
  const tips = sorted.filter((event) => !superseded.has(event.id));
  const tip = tips[tips.length - 1];
  // No tip means the base tags form a cycle — corrupt, but not worth
  // throwing over; the timestamp order is still something to show.
  if (!tip || sorted[sorted.length - 1].id === tip.id) return sorted;
  return [...sorted.filter((event) => event.id !== tip.id), tip];
}
