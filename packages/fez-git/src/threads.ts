import type { PushEntry } from "./journal.js";

/**
 * Branch → thread, as a pure plan.
 *
 * The model, stated in headless.ts since before any of this was built:
 * a repo is a channel, a branch is a thread. This module turns "what
 * the journal says happened" plus "what the channel already shows" into
 * the messages that close the gap. Pure on purpose — the scheduled task
 * that runs it is glue, and the part worth testing is here.
 *
 * Restart-safe WITHOUT local state: the channel itself is the cursor.
 * A push is "already posted" iff some message in the channel contains
 * its short sha, and a branch's thread root is found by its marker
 * line. The sentinel can die, move machines, or run twice — the worst
 * case is a skipped post when a chat message happens to quote the same
 * sha, never a duplicate flood. (Same trade the summary indexer makes:
 * the relay is the only state that counts.)
 */

export interface ChannelMsg {
  id: string;
  content: string;
  /** Non-empty e-tags mean this is a reply, not a thread root. */
  isReply: boolean;
}

export interface ThreadPost {
  text: string;
  /** Absent = open a new thread root for this branch. */
  threadRoot?: string;
  branch: string;
}

const ZERO = "0".repeat(40);
const short = (sha: string): string => sha.slice(0, 8);

/** The marker a branch's thread root carries. One definition, both sides. */
export const rootMarker = (branch: string): string => `⑂ \`${branch}\``;

/** The stub a child branch leaves in its line's thread. */
export const stubMarker = (branch: string): string => `↳ \`${branch}\``;

/**
 * The LINE a branch belongs to, by naming convention.
 *
 * `reviewer/feat-auth` is reviewer's work ON the feat-auth line — git
 * has no sub-branches, so the hierarchy is exactly two ordinary facts:
 * where a branch was cut from, and what it is named. The name is the
 * one the thread task can see, so it is what routes the stub. A branch
 * with no slash (`feat-auth`, `main`) IS a line; one with a slash is
 * somebody's work on whatever follows the first slash.
 */
export const lineOf = (branch: string): string | undefined => {
  const at = branch.indexOf("/");
  return at > 0 ? branch.slice(at + 1) : undefined;
};

/**
 * Only heads become threads. Tags and other namespaces are news, but a
 * thread per tag would bury the conversations the threads exist for.
 */
const branchOf = (ref: string): string | undefined =>
  ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;

export function planThreadPosts(
  entries: PushEntry[],
  messages: ChannelMsg[],
  nameOf: (pubkey: string) => string = (pk) => pk.slice(0, 8)
): ThreadPost[] {
  const posts: ThreadPost[] = [];
  /** Roots that exist on the relay, plus ones this plan is about to open. */
  const roots = new Map<string, string | "pending">();
  for (const message of messages) {
    if (message.isReply) continue;
    for (const entry of entries) {
      const branch = branchOf(entry.ref);
      if (!branch) continue;
      if (message.content.includes(rootMarker(branch))) roots.set(branch, message.id);
      // A line's root exists whether or not the line branch itself has
      // ever been pushed — /repo branch opens it as a declaration.
      const line = lineOf(branch);
      if (line && message.content.includes(rootMarker(line))) roots.set(line, message.id);
    }
  }

  const seen = (sha: string): boolean => messages.some((m) => m.content.includes(short(sha)));

  for (const entry of entries.slice().sort((a, b) => a.ts - b.ts)) {
    const branch = branchOf(entry.ref);
    if (!branch) continue;
    const who = nameOf(entry.pusher);
    const root = roots.get(branch);

    if (entry.new === ZERO) {
      // Deletion. Only news when the thread exists — a branch that
      // lived and died between polls was never reported here. The
      // dedupe token is the parenthetical, not the bare sha: the push
      // that CREATED that sha already put it in the channel.
      const token = `deleted (was \`${short(entry.old)}\`)`;
      if (root === undefined || root === "pending") continue;
      if (messages.some((m) => m.content.includes(token))) continue;
      posts.push({ branch, threadRoot: root, text: `⑂ ${who} ${token}` });
      continue;
    }

    if (seen(entry.new)) continue; // already told, or being discussed

    if (root === undefined) {
      // First sight of this branch: the root IS the first push report.
      posts.push({ branch, text: `${rootMarker(branch)} — ${who} pushed \`${short(entry.new)}\`` });
      roots.set(branch, "pending");
      // A branch named onto a LINE leaves a stub in the line's thread —
      // the index entry that makes lanes navigable. Only when the line's
      // root actually exists (someone opened it): a plain agent branch
      // like `researcher/work` has no "work" line and gets no stub.
      const line = lineOf(branch);
      const lineRoot = line ? roots.get(line) : undefined;
      if (lineRoot && lineRoot !== "pending" && !messages.some((m) => m.content.includes(stubMarker(branch)))) {
        posts.push({ branch, threadRoot: lineRoot, text: `${stubMarker(branch)} — ${who} is working this line` });
      }
    } else if (root === "pending") {
      // A second push to a branch whose root this same plan is opening:
      // the root's id does not exist yet, so wait — the next poll sees
      // the root on the relay and threads this sha under it.
      continue;
    } else {
      posts.push({ branch, threadRoot: root, text: `⑂ ${who} pushed \`${short(entry.new)}\`` });
    }
  }
  return posts;
}
