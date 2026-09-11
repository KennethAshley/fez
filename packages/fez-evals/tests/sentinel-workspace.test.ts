import { expect, it, vi } from "vitest";
import { refreshWorkspace } from "../../fez-sentinel/src/index.js";

it("updates workspace scope even when two relays have the same owner", async () => {
  let relay = "wss://first";
  const write = vi.fn();
  const owner = "a".repeat(64);
  await refreshWorkspace(() => relay, async () => ({ pubkey: owner }), write);
  relay = "wss://second";
  await refreshWorkspace(() => relay, async () => ({ pubkey: owner }), write);
  expect(write.mock.calls.map(([value]) => value.relayUrl)).toEqual(["wss://first", "wss://second"]);
  await refreshWorkspace(() => relay, async () => undefined, write);
  expect(write).toHaveBeenLastCalledWith({ relayUrl: "wss://second", owner: undefined, info: undefined });
});

it("does not install stale workspace ownership after a switch during NIP-11 lookup", async () => {
  let relay = "wss://first";
  const write = vi.fn();
  const result = await refreshWorkspace(() => relay, async () => { relay = "wss://second"; return { pubkey: "a".repeat(64) }; }, write);
  expect(result).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});
