import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseQuery } from "../../fez-client/dist/query-lang.js";

/**
 * The read bridge behind @fezchat/loom's live tools. These don't drive the
 * GUI agent loop — they pin the CONTRACT the bridge depends on:
 *   1. the sentences the @loom persona is told to write parse into bounded,
 *      correctly-sourced queries (garbage never throws — it degrades),
 *   2. an ```artifact:live``` block extracts as a "live" artifact, and
 *   3. the sandbox stays walled (read-only, no network egress).
 */

// The persona/agent-prompt example phrasings. If parseQuery stops
// understanding these, generated tools silently return nothing.
const PHRASES: [string, string, Partial<{ open: boolean; sinceDays: number }>][] = [
  ["open approvals", "approvals", { open: true }],
  ["open tasks", "tasks", { open: true }],
  ["pages this week", "pages", { sinceDays: 7 }],
  ["mentions", "mentions", {}],
  ["runs", "runs", {}],
  ["open tasks grouped by page", "tasks", { open: true }],
];

describe("loom read bridge — query contract", () => {
  for (const [phrase, source, extra] of PHRASES) {
    it(`"${phrase}" → ${source}, bounded`, () => {
      const q = parseQuery(phrase);
      expect(q.source).toBe(source);
      expect(q.limit).toBeGreaterThan(0); // always bounded — never an unbounded scan
      if (extra.open !== undefined) expect(q.open).toBe(extra.open);
      if (extra.sinceDays !== undefined) expect(q.sinceDays).toBe(extra.sinceDays);
    });
  }

  it("degrades instead of throwing on nonsense — an empty tool, not a crash", () => {
    const q = parseQuery("make me a turkey sandwich");
    expect(q).toBeTruthy();
    expect(q.limit).toBeGreaterThan(0);
    expect(Array.isArray(q.unknown)).toBe(true); // unknown words surfaced, never silent
  });
});

describe("loom read bridge — artifact:live extraction", () => {
  // The same fence the agent runtime uses (agent.ts ARTIFACT_FENCE).
  const FENCE = /```artifact:([\w-]+)(?:[ \t]+title="([^"\n]*)")?\r?\n([\s\S]*?)```/g;

  it("extracts a live artifact with its type and title", () => {
    const reply = [
      "here's a board of open approvals — it updates itself",
      "",
      '```artifact:live title="Open approvals"',
      "<div id=x></div><script>window.fez.subscribe('open approvals', ()=>{})</script>",
      "```",
    ].join("\n");
    const matches = [...reply.matchAll(FENCE)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("live");
    expect(matches[0][2]).toBe("Open approvals");
    expect(matches[0][3]).toContain("window.fez.subscribe");
  });
});

describe("loom read bridge — sandbox stays walled", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../fez-desktop/src/live-artifact.tsx", import.meta.url)),
    "utf8"
  );

  it("blocks all network egress from the tool frame", () => {
    expect(src).toContain("connect-src 'none'");
    expect(src).toContain("form-action 'none'");
  });

  it("exposes only read verbs, never a write/publish path", () => {
    expect(src).toContain("window.fez");
    expect(src).toContain("query");
    expect(src).toContain("subscribe");
    // the read-only half — no publish/sign surface leaks into the frame
    expect(src.includes("window.fez")).toBe(true);
    expect(/window\.fez\s*=\s*{[^}]*publish/i.test(src)).toBe(false);
  });
});
