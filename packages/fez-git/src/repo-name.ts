/**
 * The repo vocabulary shared by every part of this package.
 *
 * `/repo new` runs in three places now — the TUI's headless part, the
 * desktop's panel, and the GUI command — and each one has to agree on
 * what a repo name is and where its remote lives. Three copies of a
 * regex is a protocol that works until somebody edits one of them,
 * which is the failure this codebase has already paid for twice (see
 * src/mentions.ts, and auth.ts's note on the URL reduction).
 */

/** `owner/name` is a GitHub shape; a fez repo is one plain name. */
export const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Where this relay serves git, as the relay itself reports it.
 *
 * NOT derived from the websocket URL. That derivation is correct on a
 * laptop and silently wrong behind any proxy that terminates TLS or puts
 * git on another host — and the failure surfaces as a confusing `git
 * push` error far from the code that guessed. The relay's fez-git
 * extension advertises this in NIP-11 from the operator-stated --origin;
 * undefined here means the relay does not serve git, or was started
 * without an origin, and the honest move is to say so rather than print
 * a plausible URL.
 *
 * Buzz lands in the same place from the other direction: its NIP-34 repo
 * announcements carry an explicit `clone` tag instead of asking clients
 * to reconstruct one.
 */
export function cloneBase(info: Record<string, unknown> | undefined): string | undefined {
  const git = info?.["fez_git"] as { clone_base?: unknown } | undefined;
  const base = git?.clone_base;
  return typeof base === "string" && /^https?:\/\//i.test(base) ? base.replace(/\/+$/, "") : undefined;
}

/** The remote for one repo under a base this relay advertised. */
export const cloneUrl = (base: string, repo: string): string => `${base}/${repo}.git`;

/**
 * The channel doc a fresh repo starts with — the channel IS the repo,
 * and its doc is the repo's front page ("repo → a channel. Its doc is
 * the repo's docs"). Written once at creation by whoever created it
 * (panel, /repo new, fez-adopt) and NEVER overwritten: after that it
 * belongs to the room, and agents edit it like any channel doc.
 */
export function repoDoc(repo: string, clone: string, upstream?: string): string {
  return [
    `# ${repo}`,
    "",
    "⑂ git repo on this relay — this channel is its home, every branch becomes a thread here.",
    "",
    `- clone: \`git clone ${clone}\``,
    "- protected: `main` — owners and admins only, fast-forward only",
    "- put an agent to work: mention it here (it gets its own branch, `<agent>/work`)",
    `- open a line of work: \`/repo branch ${repo} <name>\`, then mention agents in its thread`,
    `- merge: \`/repo merge ${repo} <branch>\` or the lane board's merge button`,
    ...(upstream ? ["", `upstream: ${upstream} — fez is the working copy; publish there with \`git push origin main\``] : []),
    "",
  ].join("\n");
}
