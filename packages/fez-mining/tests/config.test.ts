import { describe, expect, it } from "vitest";
import { resolveConfig, validateConfig } from "../src/config.js";
import type { ConfigField } from "@fezchat/extension-api";

const schema: ConfigField[] = [
  { key: "provider", label: "Provider", type: "select", options: ["chutes", "anthropic"], default: "chutes" },
  { key: "dailyCap", label: "Daily cap", type: "number", default: 8 },
  { key: "providerKey", label: "Provider key", type: "secret", required: true },
];

describe("resolveConfig", () => {
  it("layers defaults, stored, secrets", () => {
    const out = resolveConfig(schema, { dailyCap: 12 }, (k) => (k === "providerKey" ? "sk-x" : undefined));
    expect(out).toEqual({ provider: "chutes", dailyCap: 12, providerKey: "sk-x" });
  });
  it("omits a secret that isn't set", () => {
    const out = resolveConfig(schema, {}, () => undefined);
    expect(out.providerKey).toBeUndefined();
    expect(out.provider).toBe("chutes");
  });
});
describe("validateConfig", () => {
  it("names the first missing required field", () => {
    expect(validateConfig(schema, { provider: "chutes" })).toBe("Provider key");
    expect(validateConfig(schema, { provider: "chutes", providerKey: "x" })).toBeNull();
  });
});
