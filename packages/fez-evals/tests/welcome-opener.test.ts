import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  OPENER_MARKER,
  NOT_READY_CUE,
  openerText,
  awakeText,
  ensureMarkedMessage,
  findMarked,
  type MarkerWire,
  type ChannelEvent,
} from "../../fez-desktop/src/welcome-core.js";

describe("welcome opener", () => {
  it("copy matrix: every readiness state says something true and actionable", () => {
    const live = openerText({ authed: true, runner: true }, "Ken");
    expect(live).toContain("@fez what can you do?");
    expect(live).toContain("Welcome, Ken.");
    expect(live).not.toContain(NOT_READY_CUE); // a live opener never grows an awake line
    const noRunner = openerText({ authed: true, runner: false }, "Ken");
    expect(noRunner).toContain("fez sentinel");
    expect(noRunner).toContain(NOT_READY_CUE);
    expect(noRunner).not.toContain("what can you do?"); // no dead invitation
    const noAuth = openerText({ authed: false, runner: false }, "");
    expect(noAuth).toContain("Settings → Agents");
    expect(noAuth).toContain(NOT_READY_CUE);
    expect(noAuth).toContain("Welcome."); // empty name degrades cleanly
    expect(awakeText()).toContain("@fez");
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
