import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle } from "../../fez-relay/dist/relay.js";
import { membershipPolicy } from "../../fez-relay/dist/policies.js";
import { RelayConnection } from "@fez/protocol";

/**
 * Read-side gate (GAPS.md §2.3, Buzz's "a registered subscription is never
 * sufficient for delivery"): with membershipPolicy loaded, h-tagged channel
 * content is delivered only to NIP-42-authed members. Non-members and
 * unauthed connections are blind on REQ *and* live fanout; channel-free
 * kinds (rosters) stay public; unauthed gated REQs get CLOSED
 * auth-required so clients can auth + retry — which the last test proves
 * end-to-end through RelayConnection's authSigner.
 */

const PORT = 7795;
const creator = generateSecretKey();
const member = generateSecretKey();
const stranger = generateSecretKey();
const memberPk = getPublicKey(member);
const now = () => Math.floor(Date.now() / 1000);
const COMM = "rg-comm";
const CH = "rg-chan";

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
  eventsFor(subId: string): { id: string; content: string }[] {
    return this.messages.filter((m) => m[0] === "EVENT" && m[1] === subId).map((m) => m[2] as never);
  }
  close(): void {
    this.ws.close();
  }
}

let relay: RelayHandle;
let secretMsg: ReturnType<typeof signAs>;

beforeAll(async () => {
  relay = startRelay({ port: PORT, policies: [membershipPolicy(getPublicKey(creator))], log: () => {} });
  const seeder = new Probe();
  await seeder.open();
  await seeder.publish(signAs(creator, 47101, JSON.stringify({ name: "private" }), [["d", "roster"]]));
  await seeder.publish(
    signAs(creator, 47102, "", [["d", "roster"], ["p", getPublicKey(creator)], ["p", memberPk]])
  );
  secretMsg = signAs(creator, 47103, "the secret plan", [["h", CH]]);
  await seeder.publish(secretMsg);
  seeder.close();
});

afterAll(() => relay.close());

describe("read gating with membershipPolicy", () => {
  test("unauthed REQ for channel content: no events, CLOSED auth-required", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "peek", { kinds: [47103], "#h": [CH] }]);
    const closed = await probe.waitFor((m) => m[0] === "CLOSED" && m[1] === "peek");
    expect(String(closed[2])).toMatch(/^auth-required/);
    expect(probe.eventsFor("peek")).toHaveLength(0);
    probe.close();
  });

  test("channel-free kinds (roster) stay publicly readable", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "roster", { kinds: [47102], "#d": ["roster"] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "roster");
    expect(probe.eventsFor("roster").length).toBeGreaterThanOrEqual(1);
    probe.close();
  });

  test("authed member reads channel content", async () => {
    const probe = new Probe();
    await probe.open();
    await probe.auth(member);
    probe.send(["REQ", "mine", { kinds: [47103], "#h": [CH] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "mine");
    expect(probe.eventsFor("mine").map((e) => e.content)).toContain("the secret plan");
    probe.close();
  });

  test("authed NON-member: no events, normal EOSE (no auth loop)", async () => {
    const probe = new Probe();
    await probe.open();
    await probe.auth(stranger);
    probe.send(["REQ", "not-mine", { kinds: [47103], "#h": [CH] }]);
    await probe.waitFor((m) => m[0] === "EOSE" && m[1] === "not-mine");
    expect(probe.eventsFor("not-mine")).toHaveLength(0);
    probe.close();
  });

  test("live fanout is gated the same way", async () => {
    const memberProbe = new Probe();
    const strangerProbe = new Probe();
    await memberProbe.open();
    await strangerProbe.open();
    await memberProbe.auth(member);
    await strangerProbe.auth(stranger);
    memberProbe.send(["REQ", "live", { kinds: [47103], "#h": [CH], since: now() }]);
    strangerProbe.send(["REQ", "live", { kinds: [47103], "#h": [CH], since: now() }]);
    await memberProbe.waitFor((m) => m[0] === "EOSE");
    await strangerProbe.waitFor((m) => m[0] === "EOSE");

    const publisher = new Probe();
    await publisher.open();
    const live = signAs(creator, 47103, "live secret", [["h", CH]]);
    await publisher.publish(live);

    await memberProbe.waitFor((m) => m[0] === "EVENT" && (m[2] as { id: string }).id === live.id);
    await new Promise((r) => setTimeout(r, 300)); // give a leak time to arrive
    expect(strangerProbe.eventsFor("live")).toHaveLength(0);
    memberProbe.close();
    strangerProbe.close();
    publisher.close();
  });

  test("search cannot side-door the read gate: unauthed gated search gets CLOSED", async () => {
    const probe = new Probe();
    await probe.open();
    probe.send(["REQ", "sneak", { kinds: [47103], "#h": [CH], search: "secret" }]);
    const closed = await probe.waitFor((m) => m[0] === "CLOSED" && m[1] === "sneak");
    expect(String(closed[2])).toMatch(/^auth-required/);
    expect(probe.eventsFor("sneak")).toHaveLength(0);
    probe.close();
  });

  test("RelayConnection with authSigner gets gated content end-to-end (auto-auth)", async () => {
    const conn = new RelayConnection({
      url: `ws://127.0.0.1:${PORT}`,
      watchdogMs: 200,
      authSigner: async (tmpl) => finalizeEvent({ ...tmpl, tags: tmpl.tags }, member),
    });
    await conn.connect();
    const received: { content: string }[] = [];
    conn.subscribe([{ kinds: [47103], "#h": [CH] }], (e) => received.push(e));
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !received.some((e) => e.content === "the secret plan")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received.map((e) => e.content)).toContain("the secret plan");
    conn.disconnect();
  });
});
