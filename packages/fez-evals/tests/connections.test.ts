import { describe, it, expect } from "vitest";
import { isStale, withFreshOAuth, markOAuthServer, connectionEntry } from "../../../src/extensions/connections.js";

/**
 * The pure logic of Connections: staleness (refresh-before-use, not
 * on-failure) and the spawn-time header swap's honest-gap behavior.
 * The interactive flow itself was proven live against Linear's
 * production MCP (see the spec) — these guard the local decisions.
 */

describe("isStale", () => {
  const now = 1_000_000_000_000;
  const blob = (over: object) => ({ tokens: { access_token: "t", expires_in: 3600 }, savedAt: now - 1000, ...over });

  it("no tokens at all → stale", () => {
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale({ tokens: {} }, now)).toBe(true);
  });
  it("fresh token → not stale", () => {
    expect(isStale(blob({}), now)).toBe(false);
  });
  it("past ~90% of lifetime → stale (refresh BEFORE expiry, not after)", () => {
    expect(isStale(blob({ savedAt: now - 3600 * 1000 * 0.95 }), now)).toBe(true);
    expect(isStale(blob({ savedAt: now - 3600 * 1000 * 0.85 }), now)).toBe(false);
  });
  it("server told us no expiry → assume usable", () => {
    expect(isStale({ tokens: { access_token: "t" } }, now)).toBe(false);
  });
});

describe("withFreshOAuth", () => {
  it("passes unmarked servers through untouched", async () => {
    const servers = [{ name: "web", headers: [{ name: "X-Thing", value: "v" }] }];
    expect(await withFreshOAuth(servers)).toEqual(servers);
  });
  it("drops a marked server whose connection can't produce a token (honest gap)", async () => {
    markOAuthServer("not-a-real-connection");
    const out = await withFreshOAuth([
      { name: "not-a-real-connection", headers: [] },
      { name: "web", headers: [] },
    ]);
    expect(out.map((s) => s.name)).toEqual(["web"]);
  });
});

describe("catalog", () => {
  it("resolves known keys and rejects unknown", () => {
    expect(connectionEntry("linear")?.url).toContain("mcp.linear.app");
    expect(connectionEntry("notion")?.url).toContain("mcp.notion.com");
    expect(connectionEntry("nope")).toBeUndefined();
  });
});
