// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { FezClient, K, setStatePersistence, type Wire } from "../../fez-client/src/index.js";
import WikiView from "../../fez-desktop/src/WikiView.js";

it("opens discussion from a passage and preserves the draft when closed and reopened", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  setStatePersistence({ exists: () => false, read: () => undefined, write: () => {} });
  const secret = generateSecretKey(), pubkey = getPublicKey(secret);
  const version = finalizeEvent({ kind: K.DOC, created_at: 100, tags: [["h", "general"], ["d", "notes"], ["title", "Notes"]], content: "# Notes\n\nA passage to discuss." }, secret);
  const wire = {
    pubkey, publish: vi.fn(async () => version), query: async () => [], subscribe: () => () => {},
    encrypt: (_peer: string, text: string) => text, decrypt: (_peer: string, text: string) => text,
    sendDm: async () => { throw Error("unexpected DM"); }, unwrapDm: () => undefined,
  } satisfies Wire;
  const client = new FezClient(wire);
  client.state.describe({ owner: pubkey });
  client.state.absorb(finalizeEvent({ kind: K.CHANNEL, tags: [["d", "general"]], content: '{"name":"general"}', created_at: 100 }, secret));
  client.state.absorb(version);
  client.setScope("general");
  vi.spyOn(client, "wikiVersions").mockResolvedValue([version]);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(WikiView, { client, initialSelection: { kind: "wiki", slug: "notes" } })));
    const panel = host.querySelector<HTMLElement>("#wiki-conversation")!;
    expect(panel.hidden).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Discuss passage"]')!.click());
    expect(panel.hidden).toBe(false);
    const input = panel.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Keep this unsent draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Close conversation"]')!.click());
    expect(panel.hidden).toBe(true);
    const toggle = host.querySelector<HTMLButtonElement>('[aria-controls="wiki-conversation"]')!;
    expect(document.activeElement).toBe(toggle);
    await act(async () => toggle.click());
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Keep this unsent draft");
    expect(wire.publish).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
