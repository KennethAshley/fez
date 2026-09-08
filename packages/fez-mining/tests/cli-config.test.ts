import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { maskConfigView, cmdConfigSet } from "../src/cli.js";
import { readState } from "../src/state.js";
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
