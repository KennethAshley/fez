import { describe, it, expect } from "vitest";
import { minersForPersona, mineArgs } from "../src/mine-cli.js";

describe("minersForPersona", () => {
  it("keeps only the persona's own miners", () => {
    const json = JSON.stringify([
      { netuid: 56, persona: "quill", desired: "running" },
      { netuid: 1, persona: "drift", desired: "running" },
    ]);
    expect(minersForPersona(json, "quill")).toEqual([
      { netuid: 56, persona: "quill", desired: "running" },
    ]);
  });
  it("returns [] for unparseable output rather than throwing", () => {
    expect(minersForPersona("not json", "quill")).toEqual([]);
  });
});

describe("mineArgs", () => {
  it("builds a metagraph invocation with persona + netuid", () => {
    expect(mineArgs.metagraph("quill", 56)).toEqual(
      ["metagraph", "--netuid", "56", "--persona", "quill", "--json"]
    );
  });
  it("builds a status invocation", () => {
    expect(mineArgs.status()).toEqual(["status", "--json"]);
  });
});
