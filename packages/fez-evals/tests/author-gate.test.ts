import { describe, expect, it } from "vitest";
import { authorAllowed, describeAuthorPolicy, parseRespondTo } from "@fez/protocol";

/**
 * The gate between a stranger and a process running shell commands on
 * the owner's machine.
 *
 * It had no test until a relay went public. The relay's membership
 * policy does not cover this: a NIP-17 DM is a gift wrap with no `h`
 * tag, so channel membership never applies to it, and an agent may be
 * pointed at a relay with no policies at all. This gate is the one that
 * actually holds.
 *
 * Its failure is invisible — an agent that answers everyone behaves
 * exactly like an agent that works — so every rule here is stated as
 * something that must be REFUSED.
 */

const OWNER = "a".repeat(64);
const SIBLING = "b".repeat(64);
const STRANGER = "c".repeat(64);
const FRIEND = "d".repeat(64);

const decide = (spec: string | undefined, author: string, opts?: { owner?: string; isSibling?: boolean }) =>
  authorAllowed({
    policy: parseRespondTo(spec),
    author,
    // key PRESENCE, not value: `{ owner: undefined }` has to mean "this
    // agent has no owner", which a `?? OWNER` default silently erases.
    owner: opts && "owner" in opts ? opts.owner : OWNER,
    isSibling: opts?.isSibling,
  });

describe("the default posture", () => {
  it("is owner-only when nothing is configured", () => {
    expect(parseRespondTo(undefined).mode).toBe("owner");
    expect(parseRespondTo("").mode).toBe("owner");
    expect(decide(undefined, OWNER)).toBe(true);
    expect(decide(undefined, STRANGER)).toBe(false);
  });

  it("admits the owner's verified siblings, and nobody else's", () => {
    expect(decide("owner", SIBLING, { isSibling: true })).toBe(true);
    expect(decide("owner", SIBLING, { isSibling: false })).toBe(false);
    // isSibling absent is not the same as true — an unresolved lookup
    // must not be read as a pass.
    expect(decide("owner", SIBLING, { isSibling: undefined })).toBe(false);
  });

  it("admits NOBODY when the agent has no owner", () => {
    // "unconfigured" must never read as "unrestricted"
    expect(decide("owner", STRANGER, { owner: undefined })).toBe(false);
    expect(decide("owner", OWNER, { owner: undefined })).toBe(false);
    expect(decide("owner", "", { owner: undefined })).toBe(false);
  });

  it("refuses an empty author", () => {
    expect(decide("owner", "")).toBe(false);
    expect(decide("anyone", "   ")).toBe(false);
  });
});

describe("a mistyped policy fails CLOSED", () => {
  // The nightmare is a misspelling publishing an agent to the internet.
  for (const typo of ["Anyone ", "anybody", "public", "all", "open", "*", "true", "everyone", "any"]) {
    it(`"${typo}" is not "anyone"`, () => {
      const policy = parseRespondTo(typo);
      if (typo.trim().toLowerCase() === "anyone") return; // " Anyone " is a legitimate spelling
      expect(policy.mode).toBe("owner");
      expect(decide(typo, STRANGER)).toBe(false);
    });
  }

  it("…but honours the real thing, including odd casing and spacing", () => {
    expect(parseRespondTo("  Anyone  ").mode).toBe("anyone");
    expect(decide("ANYONE", STRANGER)).toBe(true);
  });

  it("a malformed allowlist admits no one rather than everyone", () => {
    expect(decide("allowlist:", STRANGER)).toBe(false);
    expect(decide("allowlist:,,,", STRANGER)).toBe(false);
    expect(parseRespondTo("allowlist:").allowlist.size).toBe(0);
  });
});

describe("allowlists", () => {
  it("admit the named pubkeys", () => {
    expect(decide(`allowlist:${FRIEND}`, FRIEND)).toBe(true);
    expect(decide(`allowlist:${FRIEND}`, STRANGER)).toBe(false);
  });

  it("tolerate spacing and casing in the spec", () => {
    expect(decide(`allowlist: ${FRIEND.toUpperCase()} , ${SIBLING}`, FRIEND)).toBe(true);
    expect(decide(`allowlist:${FRIEND}`, FRIEND.toUpperCase())).toBe(true);
  });

  it("ADD to owner and siblings rather than replacing them", () => {
    // Naming one collaborator must never lock out your own fleet.
    expect(decide(`allowlist:${FRIEND}`, OWNER)).toBe(true);
    expect(decide(`allowlist:${FRIEND}`, SIBLING, { isSibling: true })).toBe(true);
  });
});

describe("anyone mode", () => {
  it("is the only way a stranger gets in", () => {
    expect(decide("anyone", STRANGER)).toBe(true);
    expect(decide("anyone", STRANGER, { owner: undefined })).toBe(true);
  });

  it("says so out loud, because an open agent should never be a surprise", () => {
    expect(describeAuthorPolicy(parseRespondTo("anyone"), OWNER)).toMatch(/OPEN/);
    expect(describeAuthorPolicy(parseRespondTo("owner"), OWNER)).toBe("owner + verified siblings");
    expect(describeAuthorPolicy(parseRespondTo("owner"), undefined)).toMatch(/NOBODY/);
    expect(describeAuthorPolicy(parseRespondTo(`allowlist:${FRIEND}`), OWNER)).toMatch(/1 allowlisted/);
  });
});

describe("the precedence the runtime relies on", () => {
  // agent.ts: env > persona frontmatter > default. Pinned here because
  // the sentinel passes no flag, so a persona edit must actually take
  // effect on respawn — and because an env var that silently loses to a
  // stale persona file is a policy change that didn't happen.
  const resolve = (env?: string, persona?: string) => parseRespondTo(env || persona || "owner");

  it("lets an explicit env override the persona", () => {
    expect(resolve("anyone", "owner").mode).toBe("anyone");
    expect(resolve(undefined, "anyone").mode).toBe("anyone");
    expect(resolve("owner", "anyone").mode).toBe("owner");
  });

  it("falls back to owner when neither is set", () => {
    expect(resolve(undefined, undefined).mode).toBe("owner");
  });
});
