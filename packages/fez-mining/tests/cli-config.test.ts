import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { maskConfigView, cmdConfigSet, cmdStop } from "../src/cli.js";
import { readState, writeState, upsertMiner } from "../src/state.js";
import type { ConfigField } from "@fezchat/extension-api";

const schema: ConfigField[] = [
  { key: "provider", label: "P", type: "string", default: "chutes" },
  { key: "providerKey", label: "K", type: "secret", required: true },
];

describe("maskConfigView", () => {
  it("shows non-secrets, masks secrets to set/unset", () => {
    const v = maskConfigView(schema, { provider: "anthropic" }, (k) => k === "providerKey");
    expect(v).toEqual({ provider: "anthropic", providerKey: "set" });
    expect(maskConfigView(schema, {}, () => false)).toEqual({ provider: "chutes", providerKey: "unset" });
  });
});

describe("cmdConfigSet (state branch)", () => {
  it("creates a stopped stub for a fresh (netuid,persona), carrying the config — no `start` required first", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fez-mine-"));
    process.env.FEZ_MINE_HOME = home;
    try {
      await cmdConfigSet(553, "quill", "provider", "chutes", false);
      const s = await readState(home);
      expect(s.miners).toEqual([
        { netuid: 553, persona: "quill", hotkey: "", desired: "stopped", config: { provider: "chutes" } },
      ]);
      // A second field on the same fresh miner merges into the same stub
      // rather than clobbering it.
      await cmdConfigSet(553, "quill", "cap", "8", false);
      expect((await readState(home)).miners[0].config).toEqual({ provider: "chutes", cap: "8" });
    } finally {
      delete process.env.FEZ_MINE_HOME;
    }
  });
});

describe("cmdStop (do machine, billing safety)", () => {
  it("no DO_API_TOKEN: does not destroy, leaves dropletId/host in state (droplet stays findable)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fez-mine-"));
    process.env.FEZ_MINE_HOME = home;
    const prevTok = process.env.DO_API_TOKEN;
    delete process.env.DO_API_TOKEN;
    try {
      let s = await readState(home);
      s = upsertMiner(s, {
        netuid: 56, persona: "gauss", hotkey: "5F", desired: "running",
        machine: { kind: "do", dropletId: 7, host: "9.9.9.9", user: "root", servePort: 7999 },
      });
      await writeState(home, s);
      await cmdStop(56, "gauss", false);
      const after = (await readState(home)).miners.find((m) => m.netuid === 56 && m.persona === "gauss");
      expect(after?.machine).toEqual({ kind: "do", dropletId: 7, host: "9.9.9.9", user: "root", servePort: 7999 });
      expect(after?.desired).toBe("stopped");
    } finally {
      delete process.env.FEZ_MINE_HOME;
      if (prevTok === undefined) delete process.env.DO_API_TOKEN; else process.env.DO_API_TOKEN = prevTok;
    }
  });

  // Review finding #1 (CRITICAL): a DELETE that fails (401/5xx/network) must
  // not be read as "destroyed" — state must keep pointing at the droplet
  // or it's orphaned (still billing, nothing left to find it by).
  it("token present but DELETE fails: does not clear dropletId/host, warns instead of claiming success", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fez-mine-"));
    process.env.FEZ_MINE_HOME = home;
    const prevTok = process.env.DO_API_TOKEN;
    process.env.DO_API_TOKEN = "tok";
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      let s = await readState(home);
      s = upsertMiner(s, {
        netuid: 56, persona: "gauss", hotkey: "5F", desired: "running",
        machine: { kind: "do", dropletId: 7, host: "9.9.9.9", user: "root", servePort: 7999 },
      });
      await writeState(home, s);
      await cmdStop(56, "gauss", false);
      const after = (await readState(home)).miners.find((m) => m.netuid === 56 && m.persona === "gauss");
      expect(after?.machine).toEqual({ kind: "do", dropletId: 7, host: "9.9.9.9", user: "root", servePort: 7999 });
      expect(after?.desired).toBe("stopped");
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.FEZ_MINE_HOME;
      if (prevTok === undefined) delete process.env.DO_API_TOKEN; else process.env.DO_API_TOKEN = prevTok;
    }
  });
});
