import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspace } from "../../fez-sentinel/src/index.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-sentinel-trust-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

it("updates workspace scope even when two relays have the same owner", async () => {
  let relay = "wss://first";
  const write = vi.fn();
  const owner = "a".repeat(64);
  await refreshWorkspace(() => relay, async () => ({ pubkey: owner }), write);
  relay = "wss://second";
  await refreshWorkspace(() => relay, async () => ({ pubkey: owner }), write);
  expect(write.mock.calls.map(([value]) => value.relayUrl)).toEqual(["wss://first", "wss://second"]);
  await refreshWorkspace(() => relay, async () => undefined, write);
  expect(write).toHaveBeenLastCalledWith({ relayUrl: "wss://second", owner, info: undefined });
});

it("clears usable authority when relay metadata conflicts with a saved pin", async () => {
  const write = vi.fn();
  await refreshWorkspace(() => "wss://first", async () => ({ pubkey: "a".repeat(64) }), write);
  await expect(refreshWorkspace(() => "wss://first", async () => ({ pubkey: "b".repeat(64) }), write)).rejects.toThrow(/owner/i);
  expect(write).toHaveBeenLastCalledWith({ relayUrl: "wss://first", owner: undefined, info: undefined });
});

it("does not install stale workspace ownership after a switch during NIP-11 lookup", async () => {
  let relay = "wss://first";
  const write = vi.fn();
  const result = await refreshWorkspace(() => relay, async () => { relay = "wss://second"; return { pubkey: "a".repeat(64) }; }, write);
  expect(result).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});
