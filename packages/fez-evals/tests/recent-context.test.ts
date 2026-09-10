import { expect, test } from "vitest";
import { RecentContexts } from "../../fez-acp/src/recent-context.js";

test("conversation history is capped at 100 scopes and an evicted queued request keeps its trigger", () => {
  const recent = new RecentContexts();
  recent.add("active", "active-id", "keep this history");
  recent.add("queued", "queued-id", "older history to evict");
  for (let i = 0; i < 98; i++) recent.add(`thread-${i}`, String(i), `message-${i}`);
  expect(recent.get("active", "unused")).toEqual(["keep this history"]);
  recent.add("new-thread", "new-id", "new message");
  expect(recent.get("queued", "ORIGINAL_QUEUED_TRIGGER")).toEqual(["ORIGINAL_QUEUED_TRIGGER"]);
  expect(recent.get("active", "unused")).toEqual(["keep this history"]);
});

test("a recent conversation keeps only its last ten messages", () => {
  const recent = new RecentContexts();
  for (let i = 0; i < 12; i++) recent.add("thread", String(i), `message-${i}`);
  const messages = recent.get("thread", "fallback");
  expect(messages).toHaveLength(10);
  expect(messages[0]).toBe("message-2");
  expect(messages.at(-1)).toBe("message-11");
});

test("revoked queued content is removed by event id without dropping an allowed identical message", () => {
  const recent = new RecentContexts();
  recent.add("thread", "revoked", "same text");
  recent.add("thread", "allowed", "same text");
  recent.remove("thread", "revoked");
  expect(recent.get("thread", "fallback")).toEqual(["same text"]);
  recent.remove("thread", "allowed");
  expect(recent.get("thread", "original trigger")).toEqual(["original trigger"]);
});
