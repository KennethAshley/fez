/**
 * Who is allowed to make an agent act — pure, eval-pinned.
 *
 * This is the boundary between a stranger and a process running shell
 * commands on the owner's machine. It matters more than the relay's
 * membership policy, because the two most common ways to reach an agent
 * route around that policy entirely: a NIP-17 DM is a gift wrap, which
 * carries no `h` tag and is therefore ungated by channel membership, and
 * an agent may be running against a relay with no policies at all.
 *
 * So the gate lives in the agent, defaults closed, and is decided here
 * rather than inline: a security rule with no test is one refactor away
 * from being open, and nothing about the failure is visible — an agent
 * that answers everyone looks exactly like an agent that works.
 *
 * The lookup that decides sibling-hood is deliberately NOT here. It
 * needs the relay, and mixing an I/O call into a decision is how the
 * decision stops being testable. Callers resolve `isSibling` and pass
 * the answer in.
 */

export type AuthorMode = "owner" | "anyone" | "allowlist";

export interface AuthorPolicy {
  mode: AuthorMode;
  /** Extra pubkeys admitted ON TOP of owner and siblings. */
  allowlist: ReadonlySet<string>;
  /** The spec as written, for logs and status lines. */
  source: string;
}

/** Pubkeys are hex; compare them one way so case can't open or close a gate. */
function normalizeKey(pubkey: string | undefined): string | undefined {
  const trimmed = pubkey?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/**
 * Read a respondTo spec.
 *
 * Anything unrecognized becomes "owner". That is the important line: a
 * typo'd policy ("Anyone", "public", "all") must fail CLOSED, because
 * the alternative is a misspelling silently publishing an agent to the
 * internet.
 */
export function parseRespondTo(spec: string | undefined): AuthorPolicy {
  const raw = (spec ?? "").trim();
  const lowered = raw.toLowerCase();

  if (lowered === "anyone") return { mode: "anyone", allowlist: new Set(), source: raw };

  if (lowered.startsWith("allowlist:")) {
    const entries = raw
      .slice("allowlist:".length)
      .split(",")
      .map((entry) => normalizeKey(entry))
      .filter((entry): entry is string => !!entry);
    return { mode: "allowlist", allowlist: new Set(entries), source: raw };
  }

  return { mode: "owner", allowlist: new Set(), source: raw || "owner" };
}

export interface AuthorDecisionInput {
  policy: AuthorPolicy;
  /** Who is trying to make the agent act. */
  author: string;
  /** The agent's owner, if it has one. */
  owner?: string;
  /**
   * Has the OWNER published a 47006 attestation naming this author?
   * Only the owner's signature counts — an agent claiming to be someone's
   * sibling is a claim anyone can make.
   */
  isSibling?: boolean;
}

/**
 * The whole rule. Owner mode = owner ∪ siblings (your agents trust each
 * other; strangers don't get in). An allowlist ADDS to that rather than
 * replacing it, so naming one collaborator never quietly locks out your
 * own fleet.
 */
export function authorAllowed({ policy, author, owner, isSibling }: AuthorDecisionInput): boolean {
  const who = normalizeKey(author);
  if (!who) return false; // no author is not an author

  if (policy.mode === "anyone") return true;
  const ownerKey = normalizeKey(owner);
  // An agent with no owner admits nobody under owner mode. Fail closed:
  // "unconfigured" must never read as "unrestricted".
  if (ownerKey && who === ownerKey) return true;
  if (policy.allowlist.has(who)) return true;
  return isSibling === true;
}

/** One line for the startup banner — an open agent should be obvious. */
export function describeAuthorPolicy(policy: AuthorPolicy, owner?: string): string {
  if (policy.mode === "anyone") return "anyone (OPEN — any pubkey can make this agent act)";
  const parts = [owner ? "owner + verified siblings" : "NOBODY (no owner configured)"];
  if (policy.allowlist.size > 0) parts.push(`${policy.allowlist.size} allowlisted`);
  return parts.join(" + ");
}
