import { describe, it, expect } from "vitest";
import { attachSkill, detachSkill, declaredSkills, rememberSkillSource } from "../../fez-desktop/src/skill-attach.js";

const persona = `---
harness: claude-code
owner: 4d9a4f80
aliases: [subnets, bittensor]
mcpServers: [bittensor, fez-wallet]
description: your Bittensor scout
---
You are @scout.
`;

const bare = `---\nharness: pi\ndescription: hi\n---\nYou are bare.\n`;

/**
 * Diffing helper for the round-trip guarantee: normalize the one line
 * these functions are allowed to touch, then the two strings must be
 * identical. Catches anything that moves outside that line — the class
 * of bug a `toContain` + line-count check cannot see.
 */
function normalizeSkillsLine(content: string): string {
  return content.replace(/^mcpServers:\s*\[[^\]]*\]/m, "mcpServers: [__NORMALIZED__]");
}

/**
 * For the insert-new-line path (no prior `mcpServers:` line): strip the
 * exact line + trailing newline that attachSkill inserted, and what's
 * left must be byte-identical to the original.
 */
function withoutInsertedLine(content: string, nl: string): string {
  return content.replace(new RegExp(`mcpServers:\\s*\\[[^\\]]*\\]${nl}`), "");
}

describe("editing a persona's declared skills", () => {
  it("reads what is declared, with sources", () => {
    expect(declaredSkills(persona)).toEqual([
      { name: "bittensor", source: undefined },
      { name: "fez-wallet", source: undefined },
    ]);
  });

  it("attaches in the portable form", () => {
    const out = attachSkill(persona, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [bittensor, fez-wallet, wallet=npm:@fezchat/wallet]");
  });

  it("attaches a source-less skill as a bare name", () => {
    expect(attachSkill(persona, "scratch")!).toContain("mcpServers: [bittensor, fez-wallet, scratch]");
  });

  it("leaves every other line untouched (replace-existing-line path)", () => {
    const out = attachSkill(persona, "polls", "npm:@fezchat/polls")!;
    expect(out).toContain("aliases: [subnets, bittensor]");
    expect(out).toContain("owner: 4d9a4f80");
    expect(out).toContain("You are @scout.");
    // The whole file, with only the touched line normalized out, must be
    // identical — not just line-count-identical.
    expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
    expect(out.split("\n").length).toBe(persona.split("\n").length);
  });

  it("attaching something already declared changes nothing", () => {
    expect(attachSkill(persona, "bittensor")).toBeUndefined();
  });

  it("detaches, preserving the sources of the survivors", () => {
    const withSource = persona.replace("fez-wallet]", "fez-wallet=npm:@fezchat/wallet]");
    const out = detachSkill(withSource, "bittensor")!;
    expect(out).toContain("mcpServers: [fez-wallet=npm:@fezchat/wallet]");
    expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(withSource));
  });

  it("detaching the last skill leaves an empty list, not a broken line", () => {
    const one = persona.replace("mcpServers: [bittensor, fez-wallet]", "mcpServers: [solo]");
    expect(detachSkill(one, "solo")!).toContain("mcpServers: []");
  });

  it("detaching something not declared changes nothing", () => {
    expect(detachSkill(persona, "github")).toBeUndefined();
  });

  it("detaching from a persona with no frontmatter changes nothing", () => {
    expect(detachSkill("just a prompt, no frontmatter\n", "wallet")).toBeUndefined();
  });

  it("a persona with no mcpServers line gains one on attach", () => {
    const out = attachSkill(bare, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("harness: pi");
    expect(out).toContain("You are bare.");
    expect(withoutInsertedLine(out, "\n")).toBe(bare);
  });

  it("a file with no frontmatter is refused rather than mangled", () => {
    expect(attachSkill("just a prompt, no frontmatter\n", "wallet")).toBeUndefined();
  });

  describe("CRLF-encoded personas", () => {
    const crlfPersona = persona.replace(/\n/g, "\r\n");
    const crlfBare = bare.replace(/\n/g, "\r\n");

    it("attach on an existing line preserves CRLF everywhere else", () => {
      const out = attachSkill(crlfPersona, "polls", "npm:@fezchat/polls")!;
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(crlfPersona));
      // No bare \n anywhere — every newline stays \r\n.
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });

    it("detach on an existing line preserves CRLF everywhere else", () => {
      const out = detachSkill(crlfPersona, "bittensor")!;
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(crlfPersona));
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });

    it("attach with no existing line inserts a CRLF line, not a mixed one", () => {
      const out = attachSkill(crlfBare, "wallet", "npm:@fezchat/wallet")!;
      expect(withoutInsertedLine(out, "\r\n")).toBe(crlfBare);
      expect(/(?<!\r)\n/.test(out)).toBe(false);
    });
  });

  describe("skill names/sources containing $-replacement patterns", () => {
    // A `$&` NAME is now refused outright by the name guard below —
    // `$` is not in npm's grammar, so nothing legitimate is lost, and
    // the splice stays literal for the source half, which is where a
    // `$&` can still legitimately arrive (a url).
    it("a $& skill name is refused, not spliced", () => {
      expect(attachSkill(persona, "pay$&day")).toBeUndefined();
    });

    it("a $& source on the replace-existing-line path is inserted literally", () => {
      const out = attachSkill(persona, "wallet", "npm:@x$&y")!;
      expect(out).toContain("mcpServers: [bittensor, fez-wallet, wallet=npm:@x$&y]");
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
    });

    it("a $& source on the insert-new-line path is inserted literally", () => {
      const out = attachSkill(bare, "payday", "npm:@x$&y")!;
      expect(out).toContain("mcpServers: [payday=npm:@x$&y]");
      expect(withoutInsertedLine(out, "\n")).toBe(bare);
    });

    it("detach preserves a survivor's $& source literally", () => {
      // Function-form replacer: a plain-string replacement argument would
      // itself fall into the `$&` trap this test exists to catch.
      const withWeirdSource = persona.replace("fez-wallet]", () => "fez-wallet=npm:@x$&y]");
      const out = detachSkill(withWeirdSource, "bittensor")!;
      expect(out).toContain("mcpServers: [fez-wallet=npm:@x$&y]");
      expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(withWeirdSource));
    });
  });

  it("a body line that merely looks like mcpServers: [...] is never mistaken for the frontmatter's", () => {
    const trap = `---\nharness: pi\ndescription: hi\n---\nSample config:\nmcpServers: [fake, entry]\nYou are bare.\n`;
    // The frontmatter has no real line, so nothing is declared...
    expect(declaredSkills(trap)).toEqual([]);
    // ...and attach must insert into the frontmatter, not "replace" the
    // look-alike line sitting in the body.
    const out = attachSkill(trap, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("Sample config:");
    expect(out).toContain("mcpServers: [fake, entry]");
    expect(out).toContain("You are bare.");
  });
});

/**
 * THE TRUST BOUNDARY.
 *
 * A skill name can arrive from a relay listing — a string a stranger
 * signed and published — and travel, unmodified, through the
 * post-install "give it to…" offer and the "give to…" toggle into a
 * PERSONA file. Frontmatter is not an inert place to put a stranger's
 * string: `]` plus a newline closes the `mcpServers: [...]` list and
 * opens whatever key the attacker names next. `aliases:` is the loudest
 * (the agent starts answering to `@admin`), but `respondTo:`, `owner:`
 * and `workdir:` are the same one character away, and the whole payload
 * renders invisibly in the UI because HTML collapses the newline.
 *
 * These functions are the choke point every one of those paths passes
 * through, so the guard lives here and the tests live with it.
 */
describe("a skill name from off this machine cannot write frontmatter", () => {
  // 22 characters. Non-empty, under 64 — passes every check that
  // existed before this guard.
  const INJECTION = 'x]\naliases: [admin, ceo';

  it("refuses the injection instead of writing it", () => {
    expect(attachSkill(persona, INJECTION)).toBeUndefined();
    expect(attachSkill(persona, INJECTION, "npm:@evil/pkg")).toBeUndefined();
    // The insert-new-line path is the same choke point.
    expect(attachSkill(bare, INJECTION)).toBeUndefined();
    expect(detachSkill(persona, INJECTION)).toBeUndefined();
    expect(rememberSkillSource(persona, INJECTION, "npm:@evil/pkg")).toBeUndefined();
  });

  it("does not gain the injected keys — the persona is byte-identical", () => {
    // Belt and braces: even if some future edit made these return a
    // string, that string must not contain the smuggled keys.
    for (const out of [attachSkill(persona, INJECTION), attachSkill(bare, INJECTION)]) {
      expect(out).toBeUndefined();
    }
    // And nothing about the original moved.
    expect(declaredSkills(persona)).toEqual([
      { name: "bittensor", source: undefined },
      { name: "fez-wallet", source: undefined },
    ]);
    expect(persona).not.toContain("admin");
  });

  it.each([
    ["a newline alone", "x\nowner: attacker"],
    ["a closing bracket alone", "x]"],
    ["a comma, which would split one name into two", "a,b"],
    ["an equals, which would forge a source", "x=npm:@evil/pkg"],
    ["a carriage return", "x\rrespondTo: everyone"],
    ["over 64 characters", "a".repeat(65)],
    ["empty", ""],
    ["whitespace, which the reader would trim away", "we b"],
  ])("refuses %s", (_label, name) => {
    expect(attachSkill(persona, name)).toBeUndefined();
    expect(detachSkill(persona, name)).toBeUndefined();
  });

  it.each(["@fezchat/wallet", "wallet", "fez-polls", "web_search", "mcp-server-git", "a.b", "Brave2"])(
    "still accepts the legitimate name %j",
    (name) => {
      const out = attachSkill(persona, name, "npm:@fezchat/wallet");
      expect(out).toBeDefined();
      expect(out).toContain(`${name}=npm:@fezchat/wallet]`);
      // Only the one line moved.
      expect(normalizeSkillsLine(out!)).toBe(normalizeSkillsLine(persona));
    }
  );
});

/**
 * The source write-back, hardened the same way — it used to live in
 * SkillsView.tsx as a whole-file regex plus
 * `content.replace(str, str)`, which is the `$&` trap this module was
 * built to close, in the same file as its own fix.
 */
describe("recording where an already-declared skill came from", () => {
  it("adds the source to the one entry, leaving the rest verbatim", () => {
    const out = rememberSkillSource(persona, "bittensor", "npm:@fezchat/bittensor")!;
    expect(out).toContain("mcpServers: [bittensor=npm:@fezchat/bittensor, fez-wallet]");
    expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
  });

  it("splices a $& source literally rather than re-substituting the match", () => {
    const out = rememberSkillSource(persona, "bittensor", "https://x.example/$&")!;
    expect(out).toContain("mcpServers: [bittensor=https://x.example/$&, fez-wallet]");
    expect(normalizeSkillsLine(out)).toBe(normalizeSkillsLine(persona));
  });

  it("never touches a body line that looks like the frontmatter's", () => {
    const trap = `---\nharness: pi\nmcpServers: [bittensor]\n---\nSample:\nmcpServers: [fake]\n`;
    const out = rememberSkillSource(trap, "bittensor", "npm:@fezchat/bittensor")!;
    expect(out).toContain("mcpServers: [bittensor=npm:@fezchat/bittensor]");
    expect(out).toContain("mcpServers: [fake]");
  });

  it("writes nothing when there is no such declaration, or it is unchanged", () => {
    expect(rememberSkillSource(persona, "nope", "npm:@x/y")).toBeUndefined();
    expect(rememberSkillSource(bare, "bittensor", "npm:@x/y")).toBeUndefined();
    const once = rememberSkillSource(persona, "bittensor", "npm:@fezchat/bittensor")!;
    expect(rememberSkillSource(once, "bittensor", "npm:@fezchat/bittensor")).toBeUndefined();
  });
});

/**
 * THE OTHER HALF OF THE SAME LINE.
 *
 * The name guard above closed one half; a SOURCE is structural too, and
 * that reads as free text until you look at the line it lives on:
 * `mcpServers: [name=source, name2=source2]` is built out of `=`, `,`
 * and `]`, and it is ONE frontmatter line, so a newline ends it.
 *
 * The reason this survived the first pass: `parseSkillSource` builds a
 * `URL` for the https branch, and WHATWG parsing STRIPS raw CR/LF — so
 * a source carrying a newline PARSES SUCCESSFULLY, and `formatSkillEntries`
 * then writes the original string rather than `url.toString()`. `LINE`'s
 * own `[^\]]*` spans newlines too, so a poisoned entry reads back as a
 * source and is re-offered to every other agent through "give it to?" —
 * durably, now that sources persist to settings.json.
 *
 * The precondition is a hostile persona already on disk (an approved
 * draft, a hand edit, an extension's `persona.update`), which is exactly
 * why the guard is here: this module is where a source stops being
 * someone else's text and becomes this machine's frontmatter.
 */
describe("a skill source cannot write frontmatter either", () => {
  // The finding's payload, verbatim: a source that `parseSkillSource`
  // accepts and that opens an `owner:` key on the way in.
  const POISON = "https://x.example/sse\nowner: attacker";

  it("refuses the newline payload rather than writing an owner: key", () => {
    expect(attachSkill(persona, "web", POISON)).toBeUndefined();
    expect(attachSkill(bare, "web", POISON)).toBeUndefined();
    expect(rememberSkillSource(persona, "bittensor", POISON)).toBeUndefined();
    // Nothing about the original moved, and no key was forged.
    expect(persona).not.toContain("owner: attacker");
    expect(declaredSkills(persona)).toEqual([
      { name: "bittensor", source: undefined },
      { name: "fez-wallet", source: undefined },
    ]);
  });

  it("refuses to REWRITE a persona whose line is already poisoned", () => {
    // Last line of defence: detach carries the survivors' sources
    // straight off the existing line, so a poisoned file must not be
    // re-blessed by an unrelated edit.
    const poisoned = persona.replace("fez-wallet]", () => `fez-wallet=${POISON}]`);
    expect(declaredSkills(poisoned)).toContainEqual({ name: "fez-wallet", source: POISON });
    expect(detachSkill(poisoned, "bittensor")).toBeUndefined();
    expect(attachSkill(poisoned, "polls", "npm:@fezchat/polls")).toBeUndefined();
  });

  it.each([
    ["a newline", "https://x.example/a\nowner: attacker"],
    ["a carriage return", "https://x.example/a\rrespondTo: everyone"],
    ["a closing bracket, which ends the list", "https://x.example/a]"],
    ["a comma, which would split one entry into two", "npm:@a/b,npm:@evil/pkg"],
    ["leading whitespace the reader would trim away", " npm:@fezchat/wallet"],
    ["trailing whitespace the reader would trim away", "npm:@fezchat/wallet "],
    ["over the length cap", `https://x.example/${"a".repeat(300)}`],
  ])("refuses a source containing %s", (_label, source) => {
    expect(attachSkill(persona, "web", source)).toBeUndefined();
    expect(rememberSkillSource(persona, "bittensor", source)).toBeUndefined();
  });

  it("treats an empty source as no source at all, not as a source to write", () => {
    // Pre-existing semantics, kept deliberately: `source` is optional
    // and a falsy one has always meant "attach the bare name". Nothing
    // structural gets written, so there is nothing here to guard.
    expect(attachSkill(persona, "web", "")).toContain("mcpServers: [bittensor, fez-wallet, web]");
    // rememberSkillSource's whole job IS the source, so an empty one is
    // refused rather than silently erasing the entry's binding.
    expect(rememberSkillSource(persona, "bittensor", "")).toBeUndefined();
  });

  it.each([
    "npm:@fezchat/wallet",
    "uvx:browser-use-mcp",
    "pipx:mcp-server-git",
    "https://mcp.example.com/sse",
    "https://mcp.example.com/sse?token&refresh",
    // `=` is ALLOWED, and this is the shape that earns it: a hosted MCP
    // url with a query-string api key. `parseSkillEntries` splits on the
    // FIRST `=` only, so the name/source split is unambiguous and the
    // rest of the url is just characters. Refusing it would have bought
    // protection from a parser that does not exist at the price of a
    // config a human would then go hunting for a bug in.
    "https://mcp.example.com/sse?key=abc",
  ])("still accepts the legitimate source %j", (source) => {
    const out = attachSkill(persona, "web", source);
    expect(out).toBeDefined();
    expect(out).toContain(`web=${source}]`);
    // Only the one line moved.
    expect(normalizeSkillsLine(out!)).toBe(normalizeSkillsLine(persona));
    expect(rememberSkillSource(persona, "bittensor", source)).toBeDefined();
  });

  it.each([
    "https://mcp.example.com/sse?token&refresh",
    // The `=` case gets its own round-trip, because "splits on the first
    // `=` only" is the entire reason `=` is allowed — if that ever
    // changed, this is the test that would go red.
    "https://mcp.example.com/sse?key=abc",
  ])("round-trips the legitimate https source %j byte for byte", (source) => {
    const out = attachSkill(persona, "web", source)!;
    expect(declaredSkills(out)).toEqual([
      { name: "bittensor", source: undefined },
      { name: "fez-wallet", source: undefined },
      { name: "web", source },
    ]);
  });

  it("keeps an `=`-carrying source intact through a later unrelated edit", () => {
    // The survivors' sources are carried off the existing line by
    // detach, so the guard sees them a second time — a query-string key
    // must survive that pass too, not just the write that put it there.
    const withKey = attachSkill(persona, "web", "https://mcp.example.com/sse?key=abc")!;
    const out = detachSkill(withKey, "bittensor")!;
    expect(out).toContain("mcpServers: [fez-wallet, web=https://mcp.example.com/sse?key=abc]");
  });
});
