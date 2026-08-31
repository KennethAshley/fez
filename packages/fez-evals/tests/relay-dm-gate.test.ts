import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle } from "../../fez-relay/dist/relay.js";
import { membershipPolicy } from "../../fez-relay/dist/policies.js";

/**
 * DM metadata channels ("dm:" + sorted participant pks): the relay gates
 * both publish and delivery to the pubkeys named IN the id — narrower
 * than the workspace roster. Non-participants (even workspace members)
 * can neither publish into nor read a DM channel, and a non-canonical id
 * ("dm:b+a", bad hex) is refused outright.
 */

const PORT = 7796;
const creator = generateSecretKey();
const alice = generateSecretKey();
const bob = generateSecretKey();
const eve = generateSecretKey(); // workspace member, NOT a participant
const alicePk = getPublicKey(alice);
const bobPk = getPublicKey(bob);
const evePk = getPublicKey(eve);
const now = () => Math.floor(Date.now() / 1000);
const DM_ID = "dm:" + [alicePk, bobPk].sort().join("+");
const RUMOR_ID = "c".repeat(64);

const signAs = (key: Uint8Array, kind: number, content: string, tags: string[][] = [], created_at = now()) =>
  finalizeEvent({ kind, created_at, tags, content }, key);

class Probe {
  ws!: WsSocket;
  messages: unknown[][] = [];
  challenge = "";
  open(): Promise<void> {
    this.ws = new WsSocket(`ws://127.0.0.1:${PORT}`);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg[0] === "AUTH") this.challenge = msg[1];
      this.messages.push(msg);
    });
    return new Promise((res, rej) => {
      this.ws.on("open", () => res());
      this.ws.on("error", rej);
    });
  }
  send(msg: unknown[]): void {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor(pred: (m: unknown[]) => boolean, timeoutMs = 3000): Promise<unknown[]> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out; got: ${JSON.stringify(this.messages.slice(-5))}`);
  }
  async auth(key: Uint8Array): Promise<void> {
    const t0 = Date.now();
    while (!this.challenge && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 25));
    const event = signAs(key, 22242, "", [["relay", `ws://127.0.0.1:${PORT}`], ["challenge", this.challenge]]);
    this.send(["AUTH", event]);
    await this.waitFor((m) => m[0] === "OK" && m[1] === event.id && m[2] === true);
  }
  async publish(event: ReturnType<typeof signAs>): Promise<void> {
    this.send(["EVENT", event]);
    await this.waitFor((m) => m[0] === "OK" && m[1] === event.id && m[2] === true);
  }
  async publishRejected(event: ReturnType<typeof signAs>): Promise<string> {
    this.send(["EVENT", event]);
    const okMsg = await this.waitFor((m) => m[0] === "OK" && m[1] === event.id);
    expect(okMsg[2]).toBe(false);
    return String(okMsg[3] ?? "");
  }
  eventsFor(subId: string): { id: string; content: string }[] {
    return this.messages.filter((m) => m[0] === "EVENT" && m[1] === subId).map((m) => m[2] as never);
  }
  close(): void {
    this.ws.close();
  }
}

let relay: RelayHandle;

beforeAll(async () => {
  relay = startRelay({ port: PORT, policies: [membershipPolicy(getPublicKey(creator))], log: () => {} });
  const seeder = new Probe();
  await seeder.open();
  await seeder.publish(
    signAs(creator, 47102, "", [["d", "roster"], ["p", getPublicKey(creator)], ["p", alicePk], ["p", bobPk], ["p", evePk]])
  );
  seeder.close();
});

afterAll(() => relay.close());

describe("dm channel participant gate", () => {
  test("a participant publishes a reaction into the dm channel", async () => {
    const probe = new Probe();
    await probe.open();
    await probe.publish(signAs(bob, 7, "👍", [["e", RUMOR_ID], ["h", DM_ID]]));
    probe.close();
  });

  test("a workspace member who is NOT a participant cannot publish", async () => {
    const probe = new Probe();
    await probe.open();
    const reason = await probe.publishRejected(signAs(eve, 7, "👀", [["e", RUMOR_ID], ["h", DM_ID]]));
    expect(reason).toMatch(/participant/);
    probe.close();
  });

  test("a participant reads the dm channel; a non-participant reads nothing", async () => {
    const aliceProbe = new Probe();
    await aliceProbe.open();
    await aliceProbe.auth(alice);
    aliceProbe.send(["REQ", "dm", { kinds: [7], "#h": [DM_ID] }]);
    await aliceProbe.waitFor((m) => m[0] === "EOSE" && m[1] === "dm");
    expect(aliceProbe.eventsFor("dm").map((e) => e.content)).toContain("👍");
    aliceProbe.close();

    const eveProbe = new Probe();
    await eveProbe.open();
    await eveProbe.auth(eve);
    eveProbe.send(["REQ", "peek", { kinds: [7], "#h": [DM_ID] }]);
    await eveProbe.waitFor((m) => m[0] === "EOSE" && m[1] === "peek");
    expect(eveProbe.eventsFor("peek")).toHaveLength(0);
    eveProbe.close();
  });

  test("non-canonical dm ids are refused even from their own 'participants'", async () => {
    const probe = new Probe();
    await probe.open();
    const unsorted = "dm:" + [alicePk, bobPk].sort().reverse().join("+");
    await probe.publishRejected(signAs(bob, 7, "👍", [["e", RUMOR_ID], ["h", unsorted]]));
    const badHex = "dm:" + alicePk + "+nothex";
    await probe.publishRejected(signAs(bob, 7, "👍", [["e", RUMOR_ID], ["h", badHex]]));
    probe.close();
  });
});
