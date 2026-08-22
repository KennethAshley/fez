import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServerResponse } from "node:http";
import { appendJournal } from "./journal.js";

const run = promisify(execFile);

/**
 * Server-side git operations the relay serves over HTTP — the read and
 * write surfaces a CLIENT needs that the git protocol itself doesn't
 * offer nicely: a review diff, and a fast-forward merge.
 *
 * Server-side on purpose, twice over:
 *
 *   - The relay HAS git and HAS the objects. A webview doing this
 *     client-side means shipping a git implementation to the browser
 *     and cloning per view (Buzz's shape, from before their relay
 *     could shell out); here it is one subprocess against a repo that
 *     is already on disk.
 *   - Merge SEMANTICS live in one place. The pre-receive hook, this
 *     endpoint, and the /repo command must agree about protection and
 *     fast-forward-only; two implementations agreeing is a promise,
 *     one implementation is a fact. The GUI button and the headless
 *     command both call THIS.
 *
 * Both endpoints ride the same auth the git transport uses: diff is
 * read-gated like clone, merge is write-gated plus the same privileged
 * check the hook applies to protected refs.
 */

/** A ref a URL may name: no options (leading -), no traversal, no globs. */
const SAFE_REF = /^[\w][\w./-]{0,200}$/;
export const safeRef = (value: string | null): string | undefined =>
  value && SAFE_REF.test(value) && !value.includes("..") ? value : undefined;

const ZERO = "0".repeat(40);

/** Cap the diff body — this crosses the network into a chat client. */
const DIFF_CAP_BYTES = 512 * 1024;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoDir, ...args], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function refSha(repoDir: string, ref: string): Promise<string | undefined> {
  return git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`])
    .then((out) => out.trim())
    .catch(() => undefined);
}

/**
 * GET fez-diff?from=<ref>&to=<ref> — the review diff.
 *
 * Three-dot semantics (merge-base..to): "what did this branch DO",
 * which is the question a reviewer is asking — not "how do these two
 * trees differ", which drags in everything the line did meanwhile.
 */
export async function serveDiff(repoDir: string, search: URLSearchParams, res: ServerResponse): Promise<void> {
  const from = safeRef(search.get("from"));
  const to = safeRef(search.get("to"));
  if (!from || !to) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("fez-diff needs ?from=<ref>&to=<ref> (plain branch names)\n");
    return;
  }
  if (!(await refSha(repoDir, to))) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no branch ${to}\n`);
    return;
  }
  // A missing FROM is the unborn-line case. The honest fallback is the
  // repo's DEFAULT branch, not `git show <tip>`: show prints only the
  // tip commit's patch, so a reviewer of a 3-commit lane saw 1 commit
  // and could approve work unseen (review finding F5). The lane was cut
  // from trunk when its line was unborn, so trunk is the right base.
  let fromRef = (await refSha(repoDir, from)) ? `refs/heads/${from}` : undefined;
  if (!fromRef) {
    const head = await git(repoDir, ["symbolic-ref", "--quiet", "HEAD"]).then((o) => o.trim()).catch(() => "");
    if (head && head !== `refs/heads/${to}` && (await refSha(repoDir, head.replace("refs/heads/", "")))) fromRef = head;
  }
  try {
    const args = fromRef
      ? ["diff", "--stat", "--patch", `${fromRef}...refs/heads/${to}`, "--"]
      : // A repo whose trunk ALSO doesn't exist yet: the branch is the
        // entire history — log every patch, oldest first.
        ["log", "--reverse", "--stat", "--patch", "--format=commit %h %s", `refs/heads/${to}`, "--"];
    const out = await git(repoDir, args);
    const body = Buffer.byteLength(out) > DIFF_CAP_BYTES ? `${out.slice(0, DIFF_CAP_BYTES)}\n… diff truncated at 512KB — review the rest in a checkout\n` : out;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`diff failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
  }
}

export interface MergeGate {
  /** May this pusher move the TARGET ref — the hook's question, asked here. */
  allowed(ref: string): Promise<boolean>;
  pusher: string;
}

/**
 * POST fez-merge?branch=<b>&into=<l> — fast-forward, atomically.
 *
 * `update-ref <ref> <new> <old>` is a compare-and-swap: two concurrent
 * merges race safely, the loser gets a plain failure instead of a lost
 * update. Fast-forward ONLY is policy — the hook refuses non-ff pushes
 * for everyone, and this endpoint keeps the same promise rather than
 * minting merge commits nobody reviewed. The move is journaled like a
 * push, so branch threads announce it with no extra machinery.
 */
export async function serveMerge(repoDir: string, search: URLSearchParams, gate: MergeGate, res: ServerResponse): Promise<void> {
  const reply = (code: number, body: Record<string, unknown>): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const branch = safeRef(search.get("branch"));
  if (!branch) return reply(400, { merged: false, reason: "fez-merge needs ?branch=<ref>" });
  // Default target: the branch's line by naming, else nothing to guess.
  const at = branch.indexOf("/");
  const into = safeRef(search.get("into")) ?? (at > 0 ? branch.slice(at + 1) : undefined);
  if (!into) return reply(400, { merged: false, reason: `\`${branch}\` names no line — pass ?into=<ref>` });

  const branchSha = await refSha(repoDir, branch);
  if (!branchSha) return reply(404, { merged: false, reason: `no branch \`${branch}\` on the relay` });

  if (!(await gate.allowed(`refs/heads/${into}`))) {
    return reply(403, { merged: false, reason: `\`${into}\` is protected — owners and admins only` });
  }

  const intoSha = await refSha(repoDir, into);
  if (intoSha === branchSha) return reply(200, { merged: true, sha: branchSha, reason: "already up to date" });
  if (intoSha) {
    const ff = await git(repoDir, ["merge-base", "--is-ancestor", intoSha, branchSha]).then(() => true).catch(() => false);
    if (!ff) {
      return reply(409, {
        merged: false,
        reason: `\`${branch}\` is not a fast-forward of \`${into}\` — the line moved since it was cut; rebase or merge in a checkout`,
      });
    }
  }

  try {
    await git(repoDir, ["update-ref", `refs/heads/${into}`, branchSha, intoSha ?? ZERO]);
  } catch {
    return reply(409, { merged: false, reason: "lost a race with a concurrent merge — re-check and retry" });
  }
  // update-ref bypasses hooks, so the journal line the post-receive hook
  // would have written is written here — the thread task's whole feed.
  appendJournal(repoDir, { ts: Math.floor(Date.now() / 1000), pusher: gate.pusher, old: intoSha ?? ZERO, new: branchSha, ref: `refs/heads/${into}` });
  return reply(200, { merged: true, sha: branchSha });
}

export interface SyncGate {
  /** Where this repo came from — the channel's recorded upstream. */
  upstream?: string;
  /** Publish credential for https upstreams (operator-configured). */
  token?: string;
  /** Owner/admin only: publishing is outward-facing. */
  privileged: boolean;
}

/**
 * POST fez-sync?ref=<branch> — publish one branch to the repo's
 * upstream (GitHub, or wherever it was adopted from).
 *
 * The relay pushes because it is the only party that can: the webview
 * has no git and, by design, no secrets. Git separates AUTHOR from
 * PUSHER, so the mirror-push carries one credential while every commit
 * keeps the agent that wrote it — the whole reason this is safe to
 * automate. One-way on purpose: fez is the working truth, the upstream
 * is a shop window; nothing here ever pulls.
 *
 * Never a force push — an upstream that diverged is a fact to surface,
 * not overwrite.
 */
export async function serveSync(repoDir: string, search: URLSearchParams, gate: SyncGate, res: ServerResponse): Promise<void> {
  const reply = (code: number, body: Record<string, unknown>): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ref = safeRef(search.get("ref"));
  if (!ref) return reply(400, { synced: false, reason: "fez-sync needs ?ref=<branch>" });
  if (!gate.privileged) return reply(403, { synced: false, reason: "publishing upstream is for owners and admins" });
  if (!gate.upstream) {
    return reply(400, { synced: false, reason: "this repo records no upstream — adopt it from one, or add `upstream` to the channel meta" });
  }
  if (!(await refSha(repoDir, ref))) return reply(404, { synced: false, reason: `no branch \`${ref}\` on the relay` });

  // https upstreams need the operator's publish credential; anything
  // else (file://, ssh) is tried as-is and fails honestly if it can't.
  let target = gate.upstream;
  if (/^https:\/\//i.test(target)) {
    if (!gate.token) {
      return reply(501, {
        synced: false,
        reason: "the relay has no publish credential — set FEZ_GITHUB_TOKEN in the relay's environment, or `git push` from a checkout",
      });
    }
    target = target.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(gate.token)}@`);
  }

  try {
    await run("git", ["-C", repoDir, "push", target, `refs/heads/${ref}:refs/heads/${ref}`], {
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
    });
    return reply(200, { synced: true, ref });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The token must never travel back out in an error line.
    const scrubbed = gate.token ? message.split(gate.token).join("<token>") : message;
    const hint = /rejected|non-fast-forward|fetch first/i.test(scrubbed)
      ? `upstream \`${ref}\` has moved — pull it into fez first (never force-pushed from here)`
      : scrubbed.split("\n").slice(0, 2).join(" ");
    return reply(409, { synced: false, reason: hint });
  }
}
