import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { JOURNAL_FILE, type PushEntry } from "./journal-format.js";

// One format, two halves: parsing (browser-safe) re-exported so every
// existing node-side import keeps working unchanged.
export * from "./journal-format.js";

/**
 * The post-receive hook. Separate from pre-receive on purpose: this one
 * runs AFTER the refs moved, so it must never fail the push — no
 * `set -e`, and appending to a file is the entire job. Recording is
 * unconditional (unlike protection, which an operator composes in), so
 * it carries its own fallbacks rather than refusing on a missing var.
 */
export const POST_RECEIVE_HOOK = `#!/usr/bin/env bash
# fez post-receive — written by the relay before every push. Do not edit.
export LC_ALL=C
JOURNAL="\${FEZ_GIT_JOURNAL:-fez-push-journal.tsv}"
WHO="\${FEZ_GIT_PUSHER:-anonymous}"
NOW=$(date +%s)
while read -r old new ref; do
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$NOW" "$WHO" "$old" "$new" "$ref" >> "$JOURNAL"
done
exit 0
`;

export const journalPath = (repoDir: string): string => path.join(repoDir, JOURNAL_FILE);

import path from "node:path";

/**
 * The push journal — what makes "a branch is a thread" possible.
 *
 * The relay cannot ANNOUNCE a push: it holds no key, deliberately, so
 * there is no fez equivalent of Buzz's relay-signed kind:30618 ref
 * update — and Buzz's own client carries a TODO admitting those events
 * are spoofable, because nothing ties them to the transport. What the
 * relay can do is RECORD: it is the transport, so a post-receive hook
 * writing "who moved which ref where" is ground truth, not an
 * assertion. The half of fez that holds the owner's key (the headless
 * part, in the sentinel or TUI) reads this journal and posts the
 * threads.
 *
 * Buzz's rule carries over verbatim: notifications derive from state,
 * never the reverse. The refs are the truth; the journal is a log of
 * how they got there; a journal line that went missing means a thread
 * post that doesn't happen, never a ref that isn't real.
 *
 * TSV, not JSON. A git refname may legally contain a double quote —
 * check-ref-format forbids space, ~, ^, :, ?, *, [, \ and control
 * characters, but not `"` — so JSON built by shell interpolation is
 * corruptible by a hostile branch name. Tabs ARE control characters,
 * which git forbids in refnames, so tab-separated fields with the ref
 * LAST cannot be confused by any name git itself would accept.
 */

/**
 * The journal's tail, for serving.
 *
 * Bounded because the file only grows and this crosses the network on a
 * poll. Truncation is safe by construction: the journal is a
 * notification surface and the refs are the truth, so a reader that
 * missed old lines missed old news, nothing more.
 */
export function readJournalTail(repoDir: string, maxLines = 500): string {
  const file = journalPath(repoDir);
  if (!existsSync(file)) return "";
  // Tail BYTES, then trim to whole lines: the journal only grows, three
  // consumers poll this, and reading the whole file made every poll
  // O(total pushes ever) (review finding). 256 bytes/line is generous —
  // ts+2 keys+2 shas+ref is ~200 — so 500 lines always fit.
  const size = statSync(file).size;
  const budget = maxLines * 256;
  const fd = openSync(file, "r");
  try {
    const start = Math.max(0, size - budget);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf-8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the cut line
    const lines = text.split("\n").filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } finally {
    closeSync(fd);
  }
}

/** Append one entry — the test seam; production appends from the hook. */
export function appendJournal(repoDir: string, entry: PushEntry): void {
  appendFileSync(journalPath(repoDir), `${entry.ts}\t${entry.pusher}\t${entry.old}\t${entry.new}\t${entry.ref}\n`);
}

/**
 * Write the post-receive hook into a bare repo. Rewritten on every push,
 * same reasoning as the pre-receive install: repos that predate this
 * must get it, and edits must take effect without a migration.
 */
export function installJournalHook(repoDir: string): void {
  const dir = path.join(repoDir, "hooks");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "post-receive");
  writeFileSync(file, POST_RECEIVE_HOOK, "utf-8");
  chmodSync(file, 0o755);
}
