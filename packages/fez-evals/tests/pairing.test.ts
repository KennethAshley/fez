import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { verifyEvent, matchFilter, type Event, type Filter } from "nostr-tools";
import { pairSend, pairReceive, deriveSas, buildPairingUri, parsePairingUri } from "@fezchat/protocol";

/**
 * Pairing gate: the whole NIP-AB-style handshake over a
 * live in-process relay — identity arrives intact when both humans
 * confirm the SAS, both sides compute the SAME SAS, and either side
 * rejecting it aborts with nothing delivered. The relay only ever sees
 * ephemeral pubkeys and ciphertext.
 */

const PORT = 7787;
let wss: WebSocketServer;
const subs = new Map<string, { subId: string; filters: Filter[]; ws: WsSocket }>();
let conn = 0;
let sawPlaintextKey = false;
const SECRET_KEY = "ab".repeat(32);

beforeAll(() => new Promise<void>((resolve) => {
  wss = new WebSocketServer({ port: PORT }, resolve);
  wss.on("connection", (ws) => {
    const id = String(conn++);
    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text.includes(SECRET_KEY)) sawPlaintextKey = true; // the leak detector
      const msg = JSON.parse(text);
      if (msg[0] === "EVENT") {
        const event = msg[1] as Event;
        if (!verifyEvent(event)) return;
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        for (const sub of subs.values()) {
          if (sub.ws.readyState === WsSocket.OPEN && sub.filters.some((f) => matchFilter(f, event))) {
            sub.ws.send(JSON.stringify(["EVENT", sub.subId, event]));
          }
        }
      } else if (msg[0] === "REQ") {
        subs.set(`${id}:${msg[1]}`, { subId: msg[1], filters: msg.slice(2), ws });
        ws.send(JSON.stringify(["EOSE", msg[1]]));
      } else if (msg[0] === "CLOSE") {
        subs.delete(`${id}:${msg[1]}`);
      }
    });
    ws.on("close", () => {
      for (const key of subs.keys()) if (key.startsWith(`${id}:`)) subs.delete(key);
    });
  });
}));

afterAll(() => new Promise<void>((resolve) => wss.close(() => resolve())));

describe("pairing", () => {
  test("uri round-trips; SAS is symmetric and pair-specific", () => {
    const uri = buildPairingUri(`ws://127.0.0.1:${PORT}`, "a".repeat(64));
    expect(parsePairingUri(uri)).toEqual({ relayUrl: `ws://127.0.0.1:${PORT}`, peerEphemeralPk: "a".repeat(64) });
    expect(parsePairingUri("nonsense")).toBeUndefined();
    expect(deriveSas("a".repeat(64), "b".repeat(64))).toBe(deriveSas("b".repeat(64), "a".repeat(64)));
    expect(deriveSas("a".repeat(64), "b".repeat(64))).not.toBe(deriveSas("a".repeat(64), "c".repeat(64)));
    expect(deriveSas("a".repeat(64), "b".repeat(64))).toMatch(/^\d{6}$/);
  });

  test("full handshake delivers the identity; both SAS match; key never crosses in plaintext", async () => {
    const sasSeen: string[] = [];
    const confirm = async (sas: string) => {
      sasSeen.push(sas);
      return true;
    };
    const received = pairReceive(`ws://127.0.0.1:${PORT}`, { confirmSas: confirm }, {
      timeoutMs: 15_000,
      onUri: (uri) => {
        void pairSend(uri, SECRET_KEY, "default", { confirmSas: confirm }, { timeoutMs: 15_000 });
      },
    });
    const result = await received;
    expect(result.key).toBe(SECRET_KEY);
    expect(result.account).toBe("default");
    expect(sasSeen).toHaveLength(2);
    expect(sasSeen[0]).toBe(sasSeen[1]); // both screens agreed
    expect(sawPlaintextKey).toBe(false); // the relay never saw the key
  }, 20_000);

  test("SAS rejection on the receiving side aborts — nothing delivered", async () => {
    let senderFailed = false;
    const received = pairReceive(`ws://127.0.0.1:${PORT}`, { confirmSas: async () => false }, {
      timeoutMs: 15_000,
      onUri: (uri) => {
        void pairSend(uri, SECRET_KEY, "default", { confirmSas: async () => true }, { timeoutMs: 15_000 }).catch(() => {
          senderFailed = true;
        });
      },
    });
    await expect(received).rejects.toThrow(/SAS/);
    await new Promise((r) => setTimeout(r, 500));
    expect(senderFailed).toBe(true); // the abort propagated to the sender
  }, 20_000);
});
