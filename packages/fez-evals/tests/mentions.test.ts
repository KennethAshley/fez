import { describe, expect, it } from "vitest";
import {
  bindMention,
  resolveMentions,
  describeMentionProblems,
  type MentionCandidate,
} from "../../fez-client/dist/mentions.js";

/**
 * A name is not an identity — it is an unverified, non-unique claim
 * someone published about themselves, in a namespace nobody owns. So
 * "@deployer" only means anything relative to an authority, and the
 * channel's creator-signed roster is the one available.
 *
 * The behaviour being replaced: a linear scan over every name the
 * client had ever seen, first match wins, map iteration order deciding.
 * A stranger who joined yesterday and called themselves "deployer"
 * could capture mentions meant for yours, silently.
 */

const OWNER = "a".repeat(64);
const DEPLOYER = "b".repeat(64);
const IMPOSTOR = "c".repeat(64);
const SHORT = "d".repeat(64);
const OUTSIDER = "e".repeat(64);

const roster: MentionCandidate[] = [
  { pubkey: OWNER, name: "Raleigh_CA", isMember: true },
  { pubkey: DEPLOYER, name: "deployer", isMember: true },
  { pubkey: SHORT, name: "dep", isMember: true },
  { pubkey: OUTSIDER, name: "researcher", isMember: false },
];

describe("the roster is the namespace", () => {
  it("resolves a member by name", () => {
    expect(resolveMentions("@deployer ship it", roster).pubkeys).toEqual([DEPLOYER]);
  });

  it("ignores non-members — tagging someone who can't read the channel is a false alarm", () => {
    const out = resolveMentions("@researcher take a look", roster);
    expect(out.pubkeys).toEqual([]);
    expect(out.unresolved).toEqual(["researcher"]);
  });

  it("does not let an outsider capture a name", () => {
    // The exact attack: someone joins the relay, calls themselves
    // "deployer", and is NOT on this channel's roster.
    const withImpostor = [...roster, { pubkey: IMPOSTOR, name: "deployer", isMember: false }];
    expect(resolveMentions("@deployer ship it", withImpostor).pubkeys).toEqual([DEPLOYER]);
  });
});

describe("matching", () => {
  it("prefers the longer name, so a short name isn't spuriously tagged", () => {
    expect(resolveMentions("@deployer go", roster).pubkeys).toEqual([DEPLOYER]);
    expect(resolveMentions("@dep go", roster).pubkeys).toEqual([SHORT]);
  });

  it("is case-insensitive, because people type how they like", () => {
    expect(resolveMentions("@DEPLOYER go", roster).pubkeys).toEqual([DEPLOYER]);
    expect(resolveMentions("@Raleigh_ca hi", roster).pubkeys).toEqual([OWNER]);
  });

  it("treats trailing punctuation as prose", () => {
    expect(resolveMentions("thanks @deployer, that worked", roster).pubkeys).toEqual([DEPLOYER]);
    expect(resolveMentions("ping @deployer!", roster).pubkeys).toEqual([DEPLOYER]);
  });

  it("does not fire mid-token, so emails and handles in prose are safe", () => {
    expect(resolveMentions("mail ken@deployer.example", roster).pubkeys).toEqual([]);
    expect(resolveMentions("path/to@deployer", roster).pubkeys).toEqual([]);
  });

  it("tags a repeated name once", () => {
    expect(resolveMentions("@deployer and again @deployer", roster).pubkeys).toEqual([DEPLOYER]);
  });

  it("handles several mentions in one message", () => {
    const out = resolveMentions("@deployer and @Raleigh_CA — go", roster);
    expect(out.pubkeys.sort()).toEqual([OWNER, DEPLOYER].sort());
  });
});

describe("ambiguity is surfaced, not guessed", () => {
  const twins: MentionCandidate[] = [
    { pubkey: DEPLOYER, name: "deployer", isMember: true },
    { pubkey: IMPOSTOR, name: "Deployer", isMember: true },
  ];

  it("tags every member who genuinely shares the name", () => {
    // A coin flip the sender never sees is the thing being removed.
    const out = resolveMentions("@deployer ship", twins);
    expect(out.pubkeys.sort()).toEqual([DEPLOYER, IMPOSTOR].sort());
    expect(out.ambiguous).toEqual([{ name: "deployer", pubkeys: [DEPLOYER, IMPOSTOR] }]);
  });

  it("says so in words the sender can act on", () => {
    expect(describeMentionProblems(resolveMentions("@deployer ship", twins))).toMatch(/matches 2 members/);
    expect(describeMentionProblems(resolveMentions("@nobody ship", roster))).toMatch(/nobody here is called @nobody/);
    expect(describeMentionProblems(resolveMentions("@deployer ship", roster))).toBeUndefined();
  });
});

describe("picking someone is the answer, not a hint", () => {
  const twins: MentionCandidate[] = [
    { pubkey: DEPLOYER, name: "deployer", isMember: true },
    { pubkey: IMPOSTOR, name: "Deployer", isMember: true },
  ];
  const bind = (name: string, pubkey: string) => bindMention(new Map(), name, pubkey);

  it("tags exactly who was chosen, where a name alone is ambiguous", () => {
    const out = resolveMentions("@deployer ship", twins, bind("deployer", IMPOSTOR));
    expect(out.pubkeys).toEqual([IMPOSTOR]);
    expect(out.ambiguous).toEqual([]);
    expect(describeMentionProblems(out)).toBeUndefined();
  });

  it("matches the binding however the sender later cases it", () => {
    expect(resolveMentions("@DEPLOYER go", twins, bind("Deployer", DEPLOYER)).pubkeys).toEqual([DEPLOYER]);
  });

  it("does not apply to a name the sender edited away from", () => {
    // Picked @deployer, then typed over it — the binding must not leak
    // onto a different name.
    const out = resolveMentions("@dep go", roster, bind("deployer", DEPLOYER));
    expect(out.pubkeys).toEqual([SHORT]);
  });

  it("is not a way around the roster — someone kicked since you picked them", () => {
    const kicked = roster.filter((c) => c.pubkey !== DEPLOYER);
    const out = resolveMentions("@deployer ship", kicked, bind("deployer", DEPLOYER));
    expect(out.pubkeys).toEqual([]);
    expect(out.unresolved).toEqual(["deployer"]);
  });

  it("leaves names that were merely typed to ordinary resolution", () => {
    const out = resolveMentions("@deployer and @Raleigh_CA", roster, bind("deployer", DEPLOYER));
    expect(out.pubkeys.sort()).toEqual([OWNER, DEPLOYER].sort());
  });

  it("re-picking the same name replaces the choice rather than adding one", () => {
    const bound = bindMention(bindMention(new Map(), "deployer", DEPLOYER), "deployer", IMPOSTOR);
    expect(resolveMentions("@deployer ship", twins, bound).pubkeys).toEqual([IMPOSTOR]);
  });
});

describe("what an agent writing hex now gets", () => {
  it("resolves to nobody, and is reported rather than silently dropped", () => {
    const out = resolveMentions("@4d9a4f80 the passage is verified", roster);
    expect(out.pubkeys).toEqual([]);
    expect(out.unresolved).toEqual(["4d9a4f80"]);
    expect(describeMentionProblems(out)).toMatch(/@4d9a4f80/);
  });
});
