import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchRelaySet } from "../../../src/shared/settings.js";

/**
 * The sentinel's ears follow the settings file. "My sentinel is down"
 * was a sentinel faithfully watching the relay set it booted with while
 * the desktop had moved the user into a different workspace — the fix
 * is one custody (settings.json) that every writer updates and this
 * watcher makes live. Rules: fire only when the SET changes (a no-op
 * save is silence), collapse write bursts, and never fire at all when
 * FEZ_RELAY env is pinned — an env override outranks the file, so a
 * file edit must not yank a pinned service.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

function tempSettings(initial: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-relay-watch-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ relays: initial }));
  return file;
}

const readRelays = (file: string) => () => {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf-8")) as { relays?: string[] }).relays ?? [];
  } catch {
    return [];
  }
};

describe("watchRelaySet", () => {
  test("a relay-set edit reaches the callback once, debounced", async () => {
    const file = tempSettings(["wss://a.example"]);
    const fired: string[][] = [];
    // debounce > fs.watch delivery latency, or the burst can split
    stop = watchRelaySet((urls) => fired.push(urls), {
      file,
      resolve: readRelays(file),
      debounceMs: 200,
    });
    // A burst of writes — the editor saving, the GUI patching twice.
    fs.writeFileSync(file, JSON.stringify({ relays: ["wss://a.example", "ws://127.0.0.1:7777"] }));
    fs.writeFileSync(file, JSON.stringify({ relays: ["wss://b.example", "ws://127.0.0.1:7777"] }));
    await expect.poll(() => fired, { timeout: 3000 }).toEqual([["wss://b.example", "ws://127.0.0.1:7777"]]);
    await sleep(250);
    expect(fired).toEqual([["wss://b.example", "ws://127.0.0.1:7777"]]);
  });

  test("a save that doesn't change the set stays silent", async () => {
    const file = tempSettings(["wss://a.example"]);
    const fired: string[][] = [];
    stop = watchRelaySet((urls) => fired.push(urls), {
      file,
      resolve: readRelays(file),
      debounceMs: 50,
    });
    fs.writeFileSync(file, JSON.stringify({ relays: ["wss://a.example"], theme: "dark" }));
    await sleep(300);
    expect(fired).toEqual([]);
  });

  test("FEZ_RELAY env pin wins: file edits never fire", async () => {
    const file = tempSettings(["wss://a.example"]);
    const fired: string[][] = [];
    stop = watchRelaySet((urls) => fired.push(urls), {
      file,
      resolve: readRelays(file),
      envRelay: "wss://pinned.example",
      debounceMs: 50,
    });
    fs.writeFileSync(file, JSON.stringify({ relays: ["wss://b.example"] }));
    await sleep(300);
    expect(fired).toEqual([]);
  });
});
