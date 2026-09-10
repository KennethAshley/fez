// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, K, setStatePersistence, type Wire } from "../../fez-client/src/index.js";
import ManagePane from "../../fez-desktop/src/ManagePane.js";
import { flash } from "../../fez-desktop/src/toast.js";

vi.mock("../../fez-desktop/src/toast.js", () => ({ flash: vi.fn() }));
vi.mock("../../fez-desktop/src/relay.js", () => ({ relaySet: () => ["ws://127.0.0.1:7777"] }));
vi.mock("../../fez-desktop/src/Avatar.js", () => ({ default: () => null }));
vi.mock("../../fez-desktop/src/UserCard.js", () => ({ default: () => null }));
afterEach(() => vi.unstubAllGlobals());

it("offers Open existing channel for a normalized match and opens that ID without publishing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setStatePersistence({ exists: () => false, read: () => undefined, write: () => {} });
  const key = generateSecretKey();
  const wire = {
    pubkey: getPublicKey(key),
    publish: vi.fn(async (template: Parameters<Wire["publish"]>[0]) => finalizeEvent({ created_at: 100, ...template }, key)),
    query: async () => [], subscribe: () => () => {},
    encrypt: (_peer: string, text: string) => text, decrypt: (_peer: string, text: string) => text,
    sendDm: async () => { throw new Error("unexpected DM"); }, unwrapDm: () => undefined,
  } satisfies Wire;
  const client = new FezClient(wire);
  client.state.describe({ owner: wire.pubkey });
  client.state.absorb(finalizeEvent({ kind: K.CHANNEL, tags: [["d", "existing"]], content: JSON.stringify({ name: "Mining" }), created_at: 100 }, key));
  client.setScope("existing");
  const onOpenChannel = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(ManagePane, { client, onOpenChannel, onClose: () => {} })));
    const input = host.querySelector<HTMLInputElement>('input[placeholder="channel name"]')!;
    const button = input.parentElement!.querySelector("button")!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button.textContent).toBe("create");
    await type("  mInInG  ");
    expect(button.textContent).toBe("Open existing channel");
    await type("new channel");
    expect(button.textContent).toBe("create");
    await type("  mInInG  ");
    await act(async () => button.click());
    expect(onOpenChannel).toHaveBeenCalledWith("existing");
    expect(wire.publish).not.toHaveBeenCalled();
    expect(flash).toHaveBeenLastCalledWith("✓ opened #mInInG");
    expect(input.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
