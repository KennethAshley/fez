import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startRelay, type RelayHandle } from "../../fez-relay/dist/relay.js";
import { membershipPolicy, moderationPolicy } from "../../fez-relay/dist/policies.js";

/**
 * moderationPolicy gate (GAPS §3, #42): the creator's kind-30047 ban list
 * enforced at the relay seam — banned pubkeys can't write community
 * content (ingest) and, when NIP-42-authed, receive none (delivery).
 * Forged ban lists are rejected at the door; unban restores writing.
 */

const PORT = 7794;
const creator = generateSecretKey();
const troll = generateSecretKey();
const trollPk = getPublicKey(troll);
const admin = generateSecretKey();
const adminPk = getPublicKey(admin);
const mallory = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);
const _COMM = "mod-comm";
const CH = "mod-chan";

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
  async publishExpect(event: ReturnType<typeof signAs>, accepted: boolean): Promise<string> {
    this.send(["EVENT", event]);
    const ok = await this.waitFor((m) => m[0] === "OK" && m[1] === event.id);
    expect(ok[2], String(ok[3])).toBe(accepted);
    return String(ok[3] ?? "");
  }
  close(): void {
    this.ws.close();
  }
}

let relay: RelayHandle;
let probe: Probe;

beforeAll(async () => {
  relay = startRelay({ port: PORT, policies: [membershipPolicy(getPublicKey(creator)), moderationPolicy(getPublicKey(creator))], log: () => {} });
  probe = new Probe();
  await probe.open();
  await probe.publishExpect(signAs(creator, 47101, JSON.stringify({ name: "main" }), [["d", "roster"]]), true);
  await probe.publishExpect(
    signAs(creator, 47102, "", [["d", "roster"], ["p", getPublicKey(creator)], ["p", adminPk, "admin"], ["p", trollPk]]),
    true
  );
});

afterAll(() => {
  probe.close();
  relay.close();
});

describe("moderationPolicy", () => {
  test("rostered member writes fine before any ban", async () => {
    await probe.publishExpect(signAs(troll, 47103, "gm", [["h", CH]]), true);
  });

  test("a forged ban list (non-member) is rejected at ingest", async () => {
    const reason = await probe.publishExpect(signAs(mallory, 30047, "", [["d", "bans"], ["p", trollPk]]), false);
    expect(reason).toMatch(/not authorized|admin|owner/);
  });

  test("after the creator bans, the banned pubkey cannot write community content", async () => {
    await probe.publishExpect(signAs(creator, 30047, "", [["d", "bans"], ["p", trollPk]]), true);
    const reason = await probe.publishExpect(signAs(troll, 47103, "still here?", [["h", CH]]), false);
    expect(reason).toMatch(/banned/);
  });

  test("an authed banned pubkey receives no community content on delivery", async () => {
    const trollProbe = new Probe();
    await trollProbe.open();
    await trollProbe.auth(troll); // roster still lists them — but the ban wins
    trollProbe.send(["REQ", "peek", { kinds: [47103], "#h": [CH] }]);
    await trollProbe.waitFor((m) => m[0] === "EOSE" && m[1] === "peek");
    expect(trollProbe.messages.filter((m) => m[0] === "EVENT" && m[1] === "peek")).toHaveLength(0);
    trollProbe.close();
  });

  test("unban (empty creator list) restores writing", async () => {
    await probe.publishExpect(signAs(creator, 30047, "", [["d", "bans"]], now() + 1), true);
    await probe.publishExpect(signAs(troll, 47103, "reformed", [["h", CH]], now() + 2), true);
  });

  // Admins (role "admin" on the owner-signed roster) may sign edicts too.
  test("an admin-signed ban is honored at ingest", async () => {
    await probe.publishExpect(signAs(admin, 30047, "", [["d", "bans"], ["p", trollPk]], now() + 10), true);
    const reason = await probe.publishExpect(signAs(troll, 47103, "hi", [["h", CH]], now() + 11), false);
    expect(reason).toMatch(/banned/);
    await probe.publishExpect(signAs(admin, 30047, "", [["d", "bans"]], now() + 12), true); // restore
    await probe.publishExpect(signAs(troll, 47103, "back", [["h", CH]], now() + 13), true);
  });
});
