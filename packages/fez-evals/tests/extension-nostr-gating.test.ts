import { describe, expect, it, beforeEach, vi } from "vitest";
import { buildApi, setNostrBackend } from "../../../src/extensions/extensions.js";

/**
 * The nostr surface must be gated by an EXPLICIT whitelist, never a spread.
 * signEvent/encrypt/decrypt use the user's key AS THEM — a spread once left
 * them raw, so a no-permission extension could sign arbitrary events and
 * decrypt private content. These tests pin the gate: the key methods refuse
 * without a grant, and only the right permission opens each.
 */

// A backend whose real methods return distinctive sentinels, so we can tell
// a real passthrough from a refused (fake/empty/throwing) call.
function fakeBackend() {
  return {
    pubkey: "pk_owner",
    publish: vi.fn(async (t: unknown) => ({ ...(t as object), id: "REAL", sig: "realsig" }) as never),
    signEvent: vi.fn((t: unknown) => ({ ...(t as object), id: "REAL", pubkey: "pk", created_at: 1, sig: "realsig" }) as never),
    subscribe: vi.fn(() => () => {}),
    query: vi.fn(async () => [] as never),
    encrypt: vi.fn(() => "CIPHER"),
    decrypt: vi.fn(() => "PLAIN"),
    sendDm: vi.fn(async () => "rumor"),
    unwrapDm: vi.fn(() => undefined),
  };
}

let bk: ReturnType<typeof fakeBackend>;
beforeEach(() => {
  bk = fakeBackend();
  setNostrBackend(bk as never);
});

const TMPL = { kind: 1, tags: [], content: "hi" };

describe("nostr surface gating — signEvent / encrypt / decrypt", () => {
  it("refuses all three for a no-permission extension (no raw leak past the whitelist)", () => {
    const api = buildApi([], "no-perms");
    // signEvent: returns an unsigned fake, real backend never called
    expect(api.nostr.signEvent(TMPL).sig).toBe("");
    expect(bk.signEvent).not.toHaveBeenCalled();
    // encrypt: empty string, backend never called
    expect(api.nostr.encrypt("peer", "secret")).toBe("");
    expect(bk.encrypt).not.toHaveBeenCalled();
    // decrypt: throws (never silently returns a wrong empty plaintext)
    expect(() => api.nostr.decrypt("peer", "cipher")).toThrow(/sign|read:dms/);
    expect(bk.decrypt).not.toHaveBeenCalled();
  });

  it('"sign" opens all three', () => {
    const api = buildApi(["sign"], "signer");
    expect(api.nostr.signEvent(TMPL).sig).toBe("realsig");
    expect(api.nostr.encrypt("peer", "secret")).toBe("CIPHER");
    expect(api.nostr.decrypt("peer", "cipher")).toBe("PLAIN");
  });

  it('"publish" implies signing (signEvent + encrypt) but NOT decrypt', () => {
    const api = buildApi(["publish"], "publisher");
    expect(api.nostr.signEvent(TMPL).sig).toBe("realsig");
    expect(api.nostr.encrypt("peer", "secret")).toBe("CIPHER");
    // decrypt is inbound/private — publish alone must not grant it
    expect(() => api.nostr.decrypt("peer", "cipher")).toThrow();
    expect(bk.decrypt).not.toHaveBeenCalled();
  });

  it('"read:dms" opens decrypt but not signEvent/encrypt', () => {
    const api = buildApi(["read:dms"], "reader");
    expect(api.nostr.decrypt("peer", "cipher")).toBe("PLAIN");
    expect(api.nostr.signEvent(TMPL).sig).toBe("");
    expect(api.nostr.encrypt("peer", "secret")).toBe("");
  });

  it("pubkey stays readable regardless of grants (it's public)", () => {
    expect(buildApi([], "x").nostr.pubkey).toBe("pk_owner");
  });
});
