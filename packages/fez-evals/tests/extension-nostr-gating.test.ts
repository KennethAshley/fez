import { describe, expect, it, beforeEach, vi } from "vitest";
import { buildApi, setNostrBackend, setClientBackend, setWorkspaceBackend, type NostrAccess } from "../../../src/extensions/extensions.js";
import { FezTUI } from "../../../src/cli/tui.js";

/**
 * The nostr surface must be gated by an EXPLICIT whitelist, never a spread.
 * signEvent/encrypt/decrypt use the user's key AS THEM — a spread once left
 * them raw, so a no-permission extension could sign arbitrary events and
 * decrypt private content. These tests pin the gate: the key methods refuse
 * without a grant, and only the right permission opens each.
 */

// A backend whose real methods return distinctive sentinels, so we can tell
// a real passthrough from a denied call, without using a key or a relay.
function fakeBackend() {
  return {
    pubkey: "pk_owner",
    publish: vi.fn(async (t: Parameters<NostrAccess["publish"]>[0]) => ({ ...t, id: "REAL", pubkey: "pk_owner", created_at: 1, sig: "realsig" })),
    signEvent: vi.fn((t: Parameters<NostrAccess["signEvent"]>[0]) => ({ ...t, id: "REAL", pubkey: "pk_owner", created_at: 1, sig: "realsig" })),
    subscribe: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    encrypt: vi.fn(() => "CIPHER"),
    decrypt: vi.fn(() => "PLAIN"),
    sendDm: vi.fn(async () => "rumor"),
    unwrapDm: vi.fn(() => undefined),
  } satisfies NostrAccess;
}

let bk: ReturnType<typeof fakeBackend>;
beforeEach(() => {
  bk = fakeBackend();
  setNostrBackend(bk);
});

const TMPL = { kind: 1, tags: [], content: "hi" };

describe("nostr surface gating — signEvent / encrypt / decrypt", () => {
  it("refuses all three for a no-permission extension (no raw leak past the whitelist)", () => {
    const api = buildApi([], "no-perms");
    expect(() => api.nostr!.signEvent(TMPL)).toThrow(/no-perms.*signEvent.*sign/);
    expect(bk.signEvent).not.toHaveBeenCalled();
    expect(() => api.nostr!.encrypt("peer", "secret")).toThrow(/no-perms.*encrypt.*sign/);
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
    expect(() => api.nostr!.signEvent(TMPL)).toThrow(/sign/);
    expect(() => api.nostr!.encrypt("peer", "secret")).toThrow(/sign/);
  });

  it("pubkey stays readable regardless of grants (it's public)", () => {
    expect(buildApi([], "x").nostr.pubkey).toBe("pk_owner");
  });
});

describe("denied relay operations report failure instead of empty success", () => {
  it("rejects asynchronous operations without touching the backend", async () => {
    const nostr = buildApi([], "read-only").nostr!;
    await expect(nostr.publish(TMPL)).rejects.toThrow(/read-only.*publish/);
    await expect(nostr.sendDm("peer", "hello")).rejects.toThrow(/read-only.*sendDm.*publish/);
    await expect(nostr.query([])).rejects.toThrow(/read-only.*query.*read:channels/);
    expect(bk.publish).not.toHaveBeenCalled();
    expect(bk.sendDm).not.toHaveBeenCalled();
    expect(bk.query).not.toHaveBeenCalled();
  });

  it("throws when a subscription or DM read is denied", () => {
    const nostr = buildApi([], "no-reads").nostr!;
    expect(() => nostr.subscribe([], () => {})).toThrow(/no-reads.*subscribe.*read:channels/);
    expect(() => nostr.unwrapDm({ ...TMPL, id: "wrap", pubkey: "peer", created_at: 1, sig: "sig" })).toThrow(/no-reads.*unwrapDm.*read:dms/);
    expect(bk.subscribe).not.toHaveBeenCalled();
    expect(bk.unwrapDm).not.toHaveBeenCalled();
  });

  it("preserves granted calls, including legitimate empty results", async () => {
    const nostr = buildApi(["publish", "read:channels", "read:dms"], "granted").nostr!;
    await expect(nostr.publish(TMPL)).resolves.toMatchObject({ id: "REAL", content: "hi" });
    expect(bk.publish).toHaveBeenCalledWith(TMPL);
    await expect(nostr.sendDm("peer", "hello")).resolves.toBe("rumor");
    expect(bk.sendDm).toHaveBeenCalledWith("peer", "hello");
    await expect(nostr.query([])).resolves.toEqual([]);
    expect(nostr.subscribe([], () => {})).toBeTypeOf("function");
    expect(nostr.unwrapDm({ ...TMPL, id: "wrap", pubkey: "peer", created_at: 1, sig: "sig" })).toBeUndefined();
  });

  it("never reports a channel created or message sent when publishing is denied", async () => {
    setWorkspaceBackend({ owner: bk.pubkey });
    const channels = buildApi(["read:channels"], "channel-reader").channels!;
    await expect(channels.ensure({ name: "new-channel" })).rejects.toThrow(/channel-reader.*publish/);
    await expect(channels.say("channel", "hello")).rejects.toThrow(/channel-reader.*publish/);
    expect(bk.publish).not.toHaveBeenCalled();
  });
});

// api.client is the SECOND door to the key: it hands out the whole FezClient
// on the mundane read:channels grant. Its crypto methods must obey the same
// gates, or #3 is trivially bypassed via api.client.signEvent/.decryptFrom.
function fakeClient() {
  return {
    displayName: vi.fn(() => "Someone"), // a mundane passthrough method
    signEvent: vi.fn(() => ({ id: "REAL", sig: "realsig" })),
    encrypt: vi.fn(() => "CIPHER"),
    decrypt: vi.fn(() => "PLAIN"),
    decryptFrom: vi.fn(async () => "PLAIN"),
  };
}

describe("api.client crypto gate — the second door", () => {
  let fc: ReturnType<typeof fakeClient>;
  beforeEach(() => {
    fc = fakeClient();
    setClientBackend(fc as never);
  });

  it("read:channels alone opens the client but NOT its crypto (the bypass is closed)", async () => {
    const api = buildApi(["read:channels"], "sneaky");
    expect(api.client).toBeDefined();
    expect(api.client!.displayName("pk")).toBe("Someone"); // mundane passthrough works
    expect(() => api.client!.signEvent({ kind: 1, tags: [], content: "" })).toThrow();
    await expect(api.client!.decryptFrom("peer", "c")).rejects.toThrow(/sneaky.*decryptFrom.*read:dms/);
    expect(() => api.client!.encrypt("peer", "t")).toThrow(/sneaky.*encrypt.*sign/);
    expect(fc.signEvent).not.toHaveBeenCalled();
    expect(fc.decryptFrom).not.toHaveBeenCalled();
  });

  it('"sign" opens the client crypto methods', async () => {
    const api = buildApi(["read:channels", "sign"], "signer");
    expect(api.client!.signEvent({ kind: 1, tags: [], content: "" })).toEqual({ id: "REAL", sig: "realsig" });
    expect(await api.client!.decryptFrom("peer", "c")).toBe("PLAIN");
    expect(api.client!.encrypt("peer", "t")).toBe("CIPHER");
  });

  it("no read:channels → no client at all", () => {
    expect(buildApi([], "none").client).toBeUndefined();
  });
});

it("shows a denied terminal command as an error and accepts the next command", async () => {
  const api = buildApi(["commands"], "terminal-denied");
  api.registerCommand("denied-probe", async () => { await api.nostr!.publish(TMPL); });
  api.registerCommand("recovery-probe", (_args, ctx) => ctx.reply("still usable"));
  const lines: string[] = [];
  // Exercise the real submit/dispatch path without a terminal or network connection.
  const tui = Object.assign(Object.create(FezTUI.prototype), {
    editor: { setText() {}, addToHistory() {} },
    questions: { handle: async () => false },
    systemLine: (text: string) => lines.push(text),
    addMessage: (message: { content: string }) => lines.push(message.content),
  }) as { onSubmit(text: string): Promise<void> };
  await expect(tui.onSubmit("/denied-probe")).resolves.toBeUndefined();
  expect(lines).toEqual([expect.stringMatching(/terminal-denied.*publish/)]);
  expect(bk.publish).not.toHaveBeenCalled();
  await tui.onSubmit("/recovery-probe");
  expect(lines[1]).toBe("still usable");
});
