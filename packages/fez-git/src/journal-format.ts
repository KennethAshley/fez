/**
 * The journal FORMAT — browser-safe on purpose.
 *
 * The GUI's lane board parses the same TSV the relay writes, so the
 * format lives apart from the node half (hooks, file IO) exactly as
 * policy.ts lives apart from protect.ts: one definition both sides
 * import, and the webview bundle never meets node:fs.
 */

export const JOURNAL_FILE = "fez-push-journal.tsv";

export interface PushEntry {
  ts: number;
  pusher: string;
  old: string;
  new: string;
  ref: string;
}

/** Parse journal bytes. Malformed lines are skipped, not fatal — the refs are the truth. */
export function parseJournal(text: string): PushEntry[] {
  const entries: PushEntry[] = [];
  for (const line of text.split("\n")) {
    const [ts, pusher, oldSha, newSha, ref] = line.split("\t");
    if (!ts || !pusher || !oldSha || !newSha || !ref) continue;
    const when = Number(ts);
    if (!Number.isFinite(when)) continue;
    entries.push({ ts: when, pusher, old: oldSha, new: newSha, ref });
  }
  return entries;
}

