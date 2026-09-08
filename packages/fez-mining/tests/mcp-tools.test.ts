import { describe, it, expect } from "vitest";
import { minersForPersona, mineArgs, classifyConfigKey } from "../src/mine-cli.js";

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

describe("mineArgs start/stop", () => {
  it("start on lium adds --machine lium", () => {
    expect(mineArgs.start("quill", 56, "lium")).toEqual(
      ["start", "--netuid", "56", "--persona", "quill", "--machine", "lium"]
    );
  });
  it("start local omits --machine", () => {
    expect(mineArgs.start("quill", 56, "local")).toEqual(
      ["start", "--netuid", "56", "--persona", "quill"]
    );
  });
  it("stop names persona + netuid", () => {
    expect(mineArgs.stop("quill", 56)).toEqual(
      ["stop", "--netuid", "56", "--persona", "quill"]
    );
  });
});

describe("mineArgs describe/configSet", () => {
  it("describe names the netuid and json", () => {
    expect(mineArgs.describe(56)).toEqual(["describe", "--netuid", "56", "--json"]);
  });
  it("configSet omits --secret (this path never writes secrets)", () => {
    expect(mineArgs.configSet("quill", 553, "dailyCap", "5")).toEqual(
      ["config", "set", "--netuid", "553", "--persona", "quill", "--key", "dailyCap", "--value", "5"]
    );
  });
});

describe("classifyConfigKey", () => {
  const schema = [
    { key: "dailyCap", label: "Daily cap", type: "number" as const },
    { key: "providerKey", label: "API key", type: "secret" as const },
  ];
  it("returns 'secret' for a secret-typed field", () => {
    expect(classifyConfigKey(schema, "providerKey")).toBe("secret");
  });
  it("returns 'ok' for a non-secret field", () => {
    expect(classifyConfigKey(schema, "dailyCap")).toBe("ok");
  });
  it("returns 'unknown' for a key not in the schema", () => {
    expect(classifyConfigKey(schema, "nope")).toBe("unknown");
  });
  it("returns 'unknown' against an empty/absent schema", () => {
    expect(classifyConfigKey([], "dailyCap")).toBe("unknown");
  });
});
