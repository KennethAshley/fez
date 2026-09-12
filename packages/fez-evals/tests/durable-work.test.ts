import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { DurableWork, workDirectory } from "../../../src/shared/durable-work.js";

const dirs: string[] = [];
const event = (n: number) => finalizeEvent({ kind: 47103, created_at: n, content: `job ${n}`, tags: [["h", "room"]] }, new Uint8Array(32).fill(4));
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("preserves queued and running work across restart, and reuses an unacknowledged signed delivery", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-inbox-")); dirs.push(dir);
  const first = event(1), second = event(2), reply = event(3);
  let inbox = new DurableWork(dir);
  inbox.accept(first); inbox.accept(second); inbox.running(first.id);
  inbox = new DurableWork(dir);
  expect(inbox.pending().map(item => [item.event.id, item.state])).toEqual([[first.id, "running"], [second.id, "queued"]]);
  expect(inbox.delivery(first.id, () => reply).id).toBe(reply.id);
  inbox = new DurableWork(dir);
  expect(inbox.delivery(first.id, () => { throw new Error("must not sign twice"); }).id).toBe(reply.id);
  inbox.finish(first.id);
  expect(new DurableWork(dir).pending().map(item => item.event.id)).toEqual([second.id]);
  expect(inbox.accept(first)).toBe(false);
});

it("fails closed on corrupt state and rejects tampered signed events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-inbox-")); dirs.push(dir);
  const inbox = new DurableWork(dir);
  expect(() => inbox.accept({ ...event(1), content: "tampered" })).toThrow();
  inbox.accept(event(2));
  fs.writeFileSync(path.join(dir, "inbox.json"), "broken");
  expect(() => new DurableWork(dir)).toThrow(/inbox/i);
});

it("isolates identities and relay sets without depending on relay order", () => {
  expect(workDirectory("a", ["wss://a", "wss://b"])).toBe(workDirectory("a", ["wss://b", "wss://a"]));
  expect(workDirectory("a", ["wss://a"])).not.toBe(workDirectory("b", ["wss://a"]));
  expect(workDirectory("a", ["wss://a"])).not.toBe(workDirectory("a", ["wss://b"]));
});
