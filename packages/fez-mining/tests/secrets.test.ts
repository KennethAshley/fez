import { describe, expect, it } from "vitest";
import { secretAccount } from "../src/secrets.js";

describe("secretAccount", () => {
  it("namespaces by netuid:persona:key", () => {
    expect(secretAccount(553, "quill", "providerKey")).toBe("553:quill:providerKey");
  });
});
