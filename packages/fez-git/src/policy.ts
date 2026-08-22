
/**
 * Branch protection, as pure policy — the rule that lets a fleet
 * share one repo.
 *
 * Split from protect.ts because this half has to run in a BROWSER.
 * The desktop's repos panel shows and edits the same rule the relay
 * enforces, and a panel that parsed `protect` its own way would show a
 * policy that was not the one applied. protect.ts keeps the half that
 * writes hooks to disk, which no webview can do.
 *
 * fez already gives every agent its own clone and its own branch
 * (workspace.ts), so concurrent pushes land on different refs and never
 * collide. That is a CONVENTION our own code follows, though: nothing
 * stopped a roster member from pushing straight to `main` and clobbering
 * the line everyone else branched from. This is the part that makes it a
 * rule the relay enforces.
 *
 * Buzz reaches the same place from the other end: `buzz-protect` tags on
 * the NIP-34 repo announcement, checked at the git transport. The shape
 * of the answer is theirs; two things are deliberately not:
 *
 *   - The policy lives in the repo's CHANNEL, not a new event kind. A
 *     repo is a channel in fez, the channel is owner-signed, and
 *     `/repo new` already writes `meta`. Inventing an announcement kind
 *     to carry one field would be a second source of truth about a repo.
 *   - No callback, no HMAC. Buzz's hook POSTs back to the relay because
 *     their relay is stateless and the repo hydrates per request, so the
 *     hook cannot see the policy. fez's roster read is synchronous and
 *     in-process: the relay resolves the whole decision BEFORE spawning
 *     git and passes it in the environment. A signed loopback request to
 *     ourselves would be ceremony around a function call.
 *
 * WHO may push a protected ref is the roster's existing answer. Kind
 * 47102 already carries `["p", pubkey, role]` with owner|admin|member|bot
 * — the same list that decides whether your messages are delivered now
 * decides whether you may move `main`. A second allow-list would be a
 * second permission model competing with the one that exists.
 */

/** Roles that may update a protected ref. Everyone else pushes their own branch. */
const PRIVILEGED = new Set(["owner", "admin"]);

/**
 * What the relay decided about this pusher, before git ran.
 *
 * Not "is this push allowed" — the relay cannot know that yet, because
 * the refs are still in the packfile. It is the two facts the hook needs
 * to decide for itself, and nothing else.
 */
export interface RefPolicy {
  /** Fully-qualified ref globs that are protected. Empty = nothing is. */
  protect: string[];
  /** May this pusher move a protected ref at all (still never force or delete). */
  privileged: boolean;
}

/**
 * `main` → `refs/heads/main`, `release/*` → `refs/heads/release/*`.
 *
 * People write branch names; git compares full refs. Doing the expansion
 * here rather than in the hook means the log line and the error message
 * say the same string the hook matched, so a policy that does not fire
 * is debuggable by reading it.
 *
 * A pattern that already names a ref namespace is left alone, which is
 * how you protect tags (`refs/tags/*`).
 */
export function qualifyRef(pattern: string): string {
  const trimmed = pattern.trim();
  return trimmed.startsWith("refs/") ? trimmed : `refs/heads/${trimmed}`;
}

/**
 * Parse the channel's `protect` field.
 *
 * `meta` values are strings — a channel's content is JSON with a flat
 * string map — so the list is comma- or space-separated. The literal
 * "none" is how an owner says "I mean zero", which has to be
 * distinguishable from "I never set this" (see `resolveProtect`).
 */
export function parseProtect(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "none") return [];
  return value
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(qualifyRef);
}

/**
 * The protected set for a repo, given whatever its channel says.
 *
 * `main` when the channel is silent, and that default is the one piece
 * of policy fez asserts rather than reads. The alternative — silence
 * means nothing is protected — is a footgun exactly when it matters: a
 * repo created before this existed, with a fleet pointed at it, would be
 * wide open and look configured. An owner who genuinely wants no
 * protection says so with `none`, and the relay logs which one it used.
 */
export function resolveProtect(metaProtect: string | undefined): string[] {
  return parseProtect(metaProtect) ?? [qualifyRef("main")];
}

/** The role this pubkey holds on the roster, or undefined if not on it. */
export function roleOf(rosterTags: string[][], pubkey: string): string | undefined {
  for (const tag of rosterTags) {
    if (tag[0] === "p" && tag[1] === pubkey) return tag[2] || "member";
  }
  return undefined;
}

export const isPrivileged = (role: string | undefined): boolean => PRIVILEGED.has(role ?? "");

