import { describe, expect, it } from "vitest";
import { consentLines, networkAllowed, parsePermissions, describePermission, has } from "../../../src/extensions/extension-permissions.js";

/**
 * Consent is only meaningful if the parse is predictable: whatever ends
 * up in `granted` is what the host will hand the extension, and whatever
 * the consent block says is what the user agreed to.
 */
describe("extension permissions", () => {
  it("parses known permissions and collects network hosts", () => {
    const parsed = parsePermissions(["read:channels", "publish", "network:api.taostats.io"]);
    expect(parsed.granted).toEqual(["read:channels", "publish", "network:api.taostats.io"]);
    expect(parsed.networkHosts).toEqual(["api.taostats.io"]);
    expect(parsed.unknown).toEqual([]);
  });

  it("surfaces unknown permissions instead of silently dropping them", () => {
    const parsed = parsePermissions(["read:channels", "read:everything"]);
    expect(parsed.granted).toEqual(["read:channels"]);
    expect(parsed.unknown).toEqual(["read:everything"]);
    // and an unknown id is described as suspicious, never as harmless
    expect(describePermission("read:everything").sensitive).toBe(true);
  });

  it("marks the permissions a person should think twice about", () => {
    const sensitive = (id: string) => describePermission(id).sensitive;
    expect(sensitive("publish")).toBe(true);
    expect(sensitive("sign")).toBe(true); // uses your key as you — think twice
    expect(sensitive("read:dms")).toBe(true);
    expect(sensitive("background")).toBe(true);
    expect(sensitive("network:*")).toBe(true);
    expect(sensitive("ui")).toBe(false);
    expect(sensitive("commands")).toBe(false);
    expect(sensitive("network:api.example.com")).toBe(false);
  });

  it("builds a consent block covering every declaration", () => {
    const lines = consentLines(["ui", "publish", "network:*", "bogus"]);
    expect(lines.map((l) => l.id)).toEqual(["ui", "publish", "network:*", "bogus"]);
    expect(lines.filter((l) => l.sensitive).map((l) => l.id)).toEqual(["publish", "network:*", "bogus"]);
  });

  it("denies network by default and allows only granted hosts", () => {
    expect(networkAllowed([], "https://api.example.com/x")).toBe(false);
    expect(networkAllowed(["api.example.com"], "https://api.example.com/x")).toBe(true);
    expect(networkAllowed(["api.example.com"], "https://evil.com/x")).toBe(false);
    // a granted host must not leak to a lookalike
    expect(networkAllowed(["example.com"], "https://example.com.evil.com/")).toBe(false);
    expect(networkAllowed(["*"], "https://anything.at.all/")).toBe(true);
  });

  it("supports leading-dot subdomain grants", () => {
    expect(networkAllowed([".example.com"], "https://api.example.com/x")).toBe(true);
    expect(networkAllowed([".example.com"], "https://example.com/x")).toBe(true);
    expect(networkAllowed([".example.com"], "https://notexample.com/x")).toBe(false);
  });

  it("refuses malformed urls rather than guessing", () => {
    expect(networkAllowed(["example.com"], "not-a-url")).toBe(false);
    expect(networkAllowed(["*"], "")).toBe(false);
  });

  it("has() is an exact membership test — no prefix surprises", () => {
    expect(has(["read:channels"], "read:channels")).toBe(true);
    expect(has(["read:channels"], "read:dms")).toBe(false);
    expect(has(undefined, "publish")).toBe(false);
  });
});
