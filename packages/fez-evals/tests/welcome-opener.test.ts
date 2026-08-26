import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  OPENER_MARKER,
  NOT_READY_CUE,
  helloText,
  openerText,
  awakeText,
  buildFezPersonaMd,
  parsePersonaBrain,
  WELCOME_CHANNEL_ID,
  ensureMarkedMessage,
  findMarked,
  STARTER_TEAM,
  teamOpenerText,
  type MarkerWire,
  type ChannelEvent,
} from "../../fez-desktop/src/welcome-core.js";
import { summonMentions } from "../../fez-sentinel/src/index.js";
import * as core from "../../fez-desktop/src/welcome-core.js";

describe("starter team — fez cast names", () => {
  it("is drift (researcher) then quill (scribe)", () => {
    expect(STARTER_TEAM.map((p) => p.id)).toEqual(["drift", "quill"]);
  });
  it("summons copy addresses both by real parser rules", () => {
    // fez-acp/sentinel addressing: each @name must open a sentence.
    expect(summonMentions(teamOpenerText(STARTER_TEAM.map((p) => p.id)))).toEqual(["drift", "quill"]);
  });
});

describe("welcome opener", () => {
  it("copy matrix: every readiness state says something true, actionable, and chat-sized", () => {
    const live = openerText({ authed: true, runner: true }, "Ken");
    expect(live).toContain("@fez what can you do?");
    expect(live).not.toContain(NOT_READY_CUE); // a live opener never grows an awake line
    const noRunner = openerText({ authed: true, runner: false }, "Ken");
    expect(noRunner).toContain("fez sentinel");
    expect(noRunner).toContain(NOT_READY_CUE);
    expect(noRunner).not.toContain("what can you do?"); // no dead invitation
    const noAuth = openerText({ authed: false, runner: false }, "");
    expect(noAuth).toContain("Settings → Agents");
    expect(noAuth).toContain(NOT_READY_CUE);
    // the hello bubble carries the name; empty name degrades cleanly
    expect(helloText("Ken")).toContain("Ken");
    expect(helloText("")).toBe("🎩 hey — welcome in.");
    // a received message, not a memo: every bubble stays chat-sized
    for (const text of [helloText("Ken"), live, noRunner, noAuth, awakeText()]) {
      expect(text.length).toBeLessThan(260);
    }
    expect(awakeText()).toContain("@fez");
  });

  it("persona builder: one template, brain lines only when fully chosen", () => {
    const claude = buildFezPersonaMd("claude-code");
    expect(claude).toContain("harness: claude-code");
    expect(claude).not.toContain("model:");
    expect(claude).not.toContain("provider:");
    const chutes = buildFezPersonaMd("pi", "deepseek-v3", "local-56105ece7a");
    expect(chutes).toContain("harness: pi");
    expect(chutes).toContain("model: deepseek-v3");
    expect(chutes).toContain("provider: local-56105ece7a");
    // model alone (without provider) emits model: for claude-code personas
    const modelAlone = buildFezPersonaMd("pi", "deepseek-v3");
    expect(modelAlone).toContain("model: deepseek-v3");
    expect(modelAlone).not.toContain("provider:");
    for (const md of [claude, chutes]) {
      expect(md).toMatch(/^---\nharness:/);
      expect(md).toContain("aliases: [orchestrator]");
      expect(md).toContain("You are @fez");
    }
  });

  it("starter team: summons by mention, inherits the brain, waits for real intros", () => {
    const { STARTER_TEAM, teamOpenerText, kickoffText, buildStarterPersonaMd, parsePersonaBrain, introCount } =
      core;
    // the opener must actually summon both — mentions are the mechanism
    const opener = teamOpenerText(STARTER_TEAM.map((p) => p.id));
    for (const p of STARTER_TEAM) expect(opener).toContain(`@${p.id}`);
    expect(opener).toContain("Don't start any work yet");
    expect(opener.length).toBeLessThan(260);
    expect(kickoffText()).toContain("What can we help you build?");

    // teammates inherit exactly the brain @fez was given — parse⇄build round-trips
    const fezMd = buildFezPersonaMd("pi", "deepseek-v3", "local-56105ece7a");
    const brain = parsePersonaBrain(fezMd);
    expect(brain).toEqual({ harness: "pi", model: "deepseek-v3", provider: "local-56105ece7a" });
    const teammate = buildStarterPersonaMd(STARTER_TEAM[0], brain.harness, brain.model, brain.provider);
    expect(teammate).toContain("harness: pi");
    expect(teammate).toContain("model: deepseek-v3");
    expect(teammate).toContain(`description: ${STARTER_TEAM[0].description}`);

    // the kickoff waits for DISTINCT teammate voices — the guide and the
    // owner don't count, and one teammate speaking twice is still one
    const guide = "aa".repeat(32), owner = "bb".repeat(32), t1 = "cc".repeat(32), t2 = "dd".repeat(32);
    const msg = (pubkey: string, content = "hi, I'm me") => ({ pubkey, content, tags: [] });
    expect(introCount([msg(guide), msg(owner)], guide, owner)).toBe(0);
    expect(introCount([msg(t1), msg(t1)], guide, owner)).toBe(1);
    expect(introCount([msg(t1), msg(t2), msg(guide)], guide, owner)).toBe(2);
  });

  it("marker idempotency: second ensure publishes nothing", async () => {
    const published: ChannelEvent[] = [];
    const wire: MarkerWire = {
      existing: async () => published,
      publish: async (tmpl) => {
        published.push({ tags: tmpl.tags, content: tmpl.content });
        return {};
      },
    };
    const first = await ensureMarkedMessage(wire, "ch1", "pk1", OPENER_MARKER, "hello");
    const second = await ensureMarkedMessage(wire, "ch1", "pk1", OPENER_MARKER, "hello");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0].tags).toContainEqual(["client", OPENER_MARKER]);
    expect(published[0].tags).toContainEqual(["p", "pk1"]);
    expect(findMarked(published, OPENER_MARKER)?.content).toBe("hello");
  });

  it("spawned relay claims its owner in NIP-11", async () => {
    const owner = "a".repeat(64);
    const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fez-relay-test-")), "events.jsonl");
    const cli = path.resolve(__dirname, "../../fez-relay/dist/cli.js");
    const port = 7911;
    const child = spawn("node", [cli, "--port", String(port), "--store", store, "--owner", owner, "--name", "test workspace"], {
      stdio: "ignore",
    });
    try {
      let info: { pubkey?: string; name?: string } | undefined;
      for (let i = 0; i < 20 && !info; i++) {
        await new Promise((r) => setTimeout(r, 250));
        info = await fetch(`http://127.0.0.1:${port}`, { headers: { Accept: "application/nostr+json" } })
          .then((r) => r.json() as Promise<{ pubkey?: string; name?: string }>)
          .catch(() => undefined);
      }
      expect(info?.pubkey).toBe(owner);
      expect(info?.name).toBe("test workspace");
    } finally {
      child.kill();
    }
  });
});

describe("persona brain — effort", () => {
  it("round-trips harness/provider/model/effort", () => {
    const md = buildFezPersonaMd("pi", "deepseek-ai/DeepSeek-V3.2", "local-56105ece7a", "high");
    expect(parsePersonaBrain(md)).toEqual({
      harness: "pi", model: "deepseek-ai/DeepSeek-V3.2", provider: "local-56105ece7a", effort: "high",
    });
  });
  it("omits effort/model/provider lines when not chosen", () => {
    const md = buildFezPersonaMd("claude-code");
    expect(md).not.toMatch(/^(effort|model|provider):/m);
  });
  it("names the welcome channel", () => {
    expect(WELCOME_CHANNEL_ID).toBe("bootstrap-welcome");
  });
});

describe("team opener × the real addressing parser", () => {
  it("every starter is an ADDRESSEE of the team opener, per fez-acp's own rules", async () => {
    // The rule that only a first or sentence-opening @name addresses is
    // correct ("if good, ping @coder" must not fire coder) — so the
    // opener's COPY must satisfy the PARSER. "@researcher and @scribe,
    // …" silently classified scribe as a downstream handoff, and half
    // the welcome team never woke. Pin copy against parser forever.
    const { addressees } = await import("../../fez-acp/src/addressing.js");
    const opener = core.teamOpenerText(core.STARTER_TEAM.map((p) => p.id));
    const named = addressees(opener);
    for (const p of core.STARTER_TEAM) expect(named).toContain(p.id);
  });
});
