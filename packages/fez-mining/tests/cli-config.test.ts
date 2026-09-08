import { describe, expect, it } from "vitest";
import { maskConfigView } from "../src/cli.js";
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
