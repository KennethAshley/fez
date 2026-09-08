import { describe, expect, it } from "vitest";
import { initialFormValues } from "../src/gui-rows.js";
import type { ConfigField } from "@fezchat/extension-api";

const schema: ConfigField[] = [
  { key: "provider", label: "P", type: "select", options: ["chutes"], default: "chutes" },
  { key: "cap", label: "C", type: "number", default: 8 },
  { key: "k", label: "K", type: "secret", required: true },
];

describe("initialFormValues", () => {
  it("seeds from defaults, secrets blank", () => {
    expect(initialFormValues(schema)).toEqual({ provider: "chutes", cap: 8, k: "" });
  });

  it("omits a non-secret field with no default", () => {
    expect(initialFormValues([{ key: "x", label: "X", type: "string" }])).toEqual({});
  });
});
