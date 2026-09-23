import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { JsonlEventStore } from "../../fez-relay/dist/stores.js";
import { startRelay } from "../../fez-relay/dist/relay.js";

/**
 * Boot-time store compaction: the append-only JSONL keeps full history,
 * but a restart must (a) serve only the compacted view and (b) rewrite
 * the file when dead weight passes the threshold — the
 * "unbounded growth from our own chattiest kinds".
 */

const sk = generateSecretKey();
const now = Math.floor(Date.now() / 1000);
const ev = (kind: number, content: string, created_at: number, tags: string[][] = []) =>
  finalizeEvent({ kind, created_at, tags, content }, sk);

function tmpStore(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fez-store-")), "events.jsonl");
}

describe("JsonlEventStore.compact", () => {
  test("rewrites the file to the surviving set, atomically", () => {
    const file = tmpStore();
    const store = new JsonlEventStore(file);
    const keep = ev(47103, "keep", now, [["h", "c"]]);
    store.append(ev(30078, "old", now - 100, [["d", "x"]]));
    store.append(keep);
    store.append(ev(30078, "older", now - 200, [["d", "x"]]));
    expect(store.load()).toHaveLength(3);
    store.compact([keep]);
    expect(store.load().map((e) => e.content)).toEqual(["keep"]);
    expect(fs.existsSync(`${file}.compact.tmp`)).toBe(false);
  });
});

describe("relay boot over an uncompacted store", () => {
  test("serves the compacted view and rewrites when dead weight passes the threshold", () => {
    const file = tmpStore();
    const store = new JsonlEventStore(file);
    // 150 revisions of one read-state row + 1 winner + 1 regular message:
    // 149 dead lines (>100 and >20% of 152) → rewrite triggers.
    for (let i = 0; i < 150; i++) store.append(ev(30078, `rev${i}`, now - 1000 + i, [["d", "chan"]]));
    const winner = ev(30078, "latest", now, [["d", "chan"]]);
    store.append(winner);
    const msg = ev(47103, "a message", now, [["h", "chan"]]);
    store.append(msg);
    expect(store.load()).toHaveLength(152);

    const lines: string[] = [];
    const relay = startRelay({ port: 7797, store: file, log: (l) => lines.push(l) });
    try {
      expect(relay.eventCount).toBe(2); // winner + message
      expect(lines.some((l) => l.includes("compacted"))).toBe(true);
      const reloaded = new JsonlEventStore(file).load();
      expect(reloaded.map((e) => e.id).sort()).toEqual([winner.id, msg.id].sort());
    } finally {
      relay.close();
    }
  });
});
