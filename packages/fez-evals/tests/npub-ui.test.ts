import { expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { decode, nsecEncode } from "nostr-tools/nip19";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import CopyNpub from "../../fez-desktop/src/CopyNpub.js";
import { npubForPubkey, pubkeyFromInput, resolvePubkeyInput } from "../../fez-desktop/src/public-key.js";

const pk = "0123456789abcdef".repeat(4);

it("encodes full hex keys canonically and refuses malformed or shortened identities", () => {
  const npub = npubForPubkey(pk)!;
  expect(npub).toMatch(/^npub1/);
  expect(decode(npub)).toEqual({ type: "npub", data: pk });
  expect(npubForPubkey(pk.toUpperCase())).toBe(npub);
  for (const invalid of ["", "abcd", "a".repeat(63), "a".repeat(65), "g".repeat(64), ` ${pk}`, `${pk}\n`, `${pk.slice(0, 8)}…${pk.slice(-4)}`, npub, `nsec${npub.slice(4)}`]) {
    expect(npubForPubkey(invalid)).toBeUndefined();
  }
});

it("accepts pasted npubs and hex keys without accepting secrets, abbreviations, or bad checksums", () => {
  const npub = npubForPubkey(pk)!;
  for (const valid of [pk, pk.toUpperCase(), npub, npub.toUpperCase(), ` ${npub}\n`]) {
    expect(pubkeyFromInput(valid)).toBe(pk);
  }
  for (const invalid of ["", "@name", nsecEncode(new Uint8Array(32).fill(1)), `${npub.slice(0, 12)}…${npub.slice(-8)}`, `${npub.slice(0, -1)}${npub.at(-1) === "q" ? "p" : "q"}`, `NPUB${npub.slice(4)}`, "g".repeat(64)]) {
    expect(pubkeyFromInput(invalid)).toBeUndefined();
  }
});

it("rejects malformed identities even when a matching name exists", () => {
  const names = new Map([["alice", pk], ["npub1invalid", "ff".repeat(32)]]);
  const lookup = (name: string) => names.get(name);
  expect(resolvePubkeyInput("alice", lookup)).toBe(pk);
  expect(resolvePubkeyInput(npubForPubkey(pk)!, lookup)).toBe(pk);
  expect(() => resolvePubkeyInput("npub1invalid", lookup)).toThrow("Invalid public key");
  expect(() => resolvePubkeyInput(nsecEncode(new Uint8Array(32).fill(1)), lookup)).toThrow("Invalid public key");
});

it("copies the full value, reports clipboard failures, and never confirms a different identity", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish!: () => void;
  const writes: string[] = [];
  let denied = false;
  vi.stubGlobal("navigator", { clipboard: { writeText: (text: string) => {
    writes.push(text);
    if (denied) return Promise.reject(Error("denied"));
    return new Promise<void>(resolve => { finish = resolve; });
  } } });
  const root = createRoot(document.getElementById("root")!);
  const render = (key: string, compact = false) => act(async () => root.render(React.createElement(CopyNpub, { pk: key, compact })));
  const button = () => document.querySelector("button")!;
  const click = () => act(async () => button().click());
  try {
    await render(pk, true);
    expect(button().textContent).toMatch(/^npub1.+…/);
    await click();
    expect(decode(writes[0])).toEqual({ type: "npub", data: pk });
    expect(button().textContent).not.toContain("copied");
    const other = "ff".repeat(32);
    await render(other);
    await act(async () => finish());
    expect(button().textContent).toBe(npubForPubkey(other));
    denied = true;
    await click();
    expect(button().textContent).toContain("Copy failed");
    denied = false;
    await click();
    await act(async () => finish());
    expect(button().textContent).toBe("✓ copied");
    expect(decode(writes.at(-1)!)).toEqual({ type: "npub", data: other });
    await render("invalid");
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Public key unavailable");
    const before = writes.length;
    await click();
    expect(writes).toHaveLength(before);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  }
});
