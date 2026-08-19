import { describe, expect, it } from "vitest";

/**
 * An invite names one relay for the guest to look at, and it has to be
 * one THEY can reach.
 *
 * `ws://localhost:7777` is the first entry in most developers' relay
 * sets, and an invite built from it sends the guest to their own
 * machine — where they find nothing, with no error, because an empty
 * relay and a wrong relay are indistinguishable from the outside. This
 * was about to burn a two-machine test.
 */
function isLoopback(url: string): boolean {
  return /^wss?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());
}

describe("relays an invite may name", () => {
  it("rejects every way of writing 'this machine'", () => {
    for (const url of [
      "ws://localhost:7777",
      "ws://127.0.0.1:7777",
      "ws://127.1.2.3:7777",
      "wss://localhost",
      "ws://[::1]:7777",
      "ws://0.0.0.0:7777",
      "  ws://LOCALHOST:7777  ",
    ]) {
      expect(isLoopback(url), url).toBe(true);
    }
  });

  it("accepts addresses a guest can actually reach", () => {
    for (const url of [
      "wss://67-205-188-204.sslip.io",
      "ws://100.125.7.88:7777", // tailnet
      "ws://192.168.1.20:7777", // LAN
      "wss://relay.example.com",
      "ws://localhost.example.com:7777", // a real host that merely starts with the word
    ]) {
      expect(isLoopback(url), url).toBe(false);
    }
  });

  it("picks the first reachable relay, not simply the first one", () => {
    const pick = (set: string) => set.split(",").map((r) => r.trim()).find((r) => !isLoopback(r));
    expect(pick("ws://localhost:7777,ws://100.125.7.88:7777")).toBe("ws://100.125.7.88:7777");
    expect(pick("wss://a.example,ws://localhost:7777")).toBe("wss://a.example");
    expect(pick("ws://localhost:7777,ws://127.0.0.1:9999")).toBeUndefined();
  });
});
