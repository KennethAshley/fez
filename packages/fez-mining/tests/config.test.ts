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
  it("coerces a stored string to the field's declared type", () => {
    const boolSchema: ConfigField[] = [{ key: "refreshNodes", label: "Refresh nodes", type: "boolean", default: true }];
    // argv strings land in stored config as-is (cmdConfigSet never types
    // them) — "false" must resolve to the boolean false, not stay a
    // truthy string.
    const out = resolveConfig(boolSchema, { refreshNodes: "false" }, () => undefined);
    expect(out.refreshNodes).toBe(false);

    const numSchema: ConfigField[] = [{ key: "dailyCap", label: "Daily cap", type: "number", default: 8 }];
    const numOut = resolveConfig(numSchema, { dailyCap: "12" }, () => undefined);
    expect(numOut.dailyCap).toBe(12);
  });
  it("falls back to default when a stored number can't coerce", () => {
    const numSchema: ConfigField[] = [{ key: "dailyCap", label: "Daily cap", type: "number", default: 8 }];
    const out = resolveConfig(numSchema, { dailyCap: "not-a-number" }, () => undefined);
    expect(out.dailyCap).toBe(8);
  });
});
describe("validateConfig", () => {
  it("names the first missing required field", () => {
    expect(validateConfig(schema, { provider: "chutes" })).toBe("Provider key");
    expect(validateConfig(schema, { provider: "chutes", providerKey: "x" })).toBeNull();
  });
});
