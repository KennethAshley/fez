import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FezClient, setStatePersistence, type Wire } from "../../fez-client/src/index.js";
import { pinWorkspaceOwner } from "../../../src/shared/workspace-owner.js";

const owner = "a".repeat(64), stranger = "b".repeat(64);
const directories: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-owner-pin-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("does not let a caller-supplied owner bypass the independently configured owner", () => {
  const dir = directory();
  vi.stubEnv("FEZ_WORKSPACE_OWNER", owner);
  expect(() => pinWorkspaceOwner("wss://relay.example", stranger, stranger, dir)).toThrow(/owner/i);
  expect(fs.readdirSync(dir)).toHaveLength(0);
  expect(pinWorkspaceOwner("wss://relay.example", owner, owner, dir)).toBe(owner);
});

it("the actual client host hook cannot TOFU-pin discovery over the configured owner", async () => {
  const dir = directory();
  vi.stubEnv("FEZ_WORKSPACE_OWNER", owner);
  setStatePersistence({ exists: () => false, read: () => undefined, write: () => {} });
  const wire: Wire = {
    pubkey: owner, relays: ["wss://relay.example"], relayInfo: async () => ({ pubkey: stranger }),
    pinWorkspaceOwner: async (relay, advertised, expected) => pinWorkspaceOwner(relay, advertised, expected, dir),
    query: async () => [], subscribe: () => () => {},
    publish: async () => { throw new Error("unexpected publish"); },
    encrypt: (_key, text) => text, decrypt: (_key, text) => text,
    sendDm: async () => "", unwrapDm: () => undefined,
  };
  const client = new FezClient(wire);
  await expect(client.openWorkspace("wss://relay.example")).rejects.toThrow(/owner/i);
  expect(client.state.workspace.owner).toBeUndefined();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it("remembers authority across callers and missing metadata without accepting a replacement owner", () => {
  const dir = directory();
  expect(pinWorkspaceOwner("wss://Relay.example:443/", owner, undefined, dir)).toBe(owner);
  expect(pinWorkspaceOwner("wss://relay.example", undefined, undefined, dir)).toBe(owner);
  expect(() => pinWorkspaceOwner("wss://relay.example", stranger, undefined, dir)).toThrow(/owner/i);
  expect(pinWorkspaceOwner("wss://relay.example", owner, undefined, dir)).toBe(owner);
  expect(pinWorkspaceOwner("wss://another.example", stranger, undefined, dir)).toBe(stranger);
});

it("pins a trusted invitation even without metadata and rejects mismatched discovery before writing", () => {
  const dir = directory();
  expect(() => pinWorkspaceOwner("wss://relay.example", stranger, owner, dir)).toThrow(/owner/i);
  expect(fs.readdirSync(dir)).toHaveLength(0);
  expect(pinWorkspaceOwner("wss://relay.example", undefined, owner, dir)).toBe(owner);
  expect(() => pinWorkspaceOwner("wss://relay.example", stranger, stranger, dir)).toThrow(/owner/i);
});

it("does not turn corrupt or unwritable trust storage into a new first use", () => {
  const dir = directory();
  pinWorkspaceOwner("wss://relay.example", owner, undefined, dir);
  const [file] = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, file), "broken");
  expect(() => pinWorkspaceOwner("wss://relay.example", stranger, undefined, dir)).toThrow();
  const blocked = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocked, "occupied");
  expect(() => pinWorkspaceOwner("wss://fresh.example", owner, undefined, blocked)).toThrow();
});
