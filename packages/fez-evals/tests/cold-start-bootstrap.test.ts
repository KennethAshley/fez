import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BrowserWire } from "../../fez-desktop/src/wire.js";
import { ensureOwnerBootstrap } from "../../fez-desktop/src/boot-workspace.js";
import {
  OPENER_MARKER,
  openerText,
  ensureMarkedMessage,
  type MarkerWire,
} from "../../fez-desktop/src/welcome-core.js";
import { FezClient, setStatePersistence } from "../../fez-client/dist/index.js";

/**
 * The cold-start contract, end to end and headless: a fresh identity
 * boots against ITS OWN local relay and must end with the workspace
 * claimed, #general existing, and the scripted @fez opener posted —
 * the Buzz-style first minute, without a GUI in sight.
 *
 * The second case is the one a fresh install actually hits: the app and
 * the relay start CONCURRENTLY, so the NIP-11 owner fetch can run
 * before the relay binds. "No owner yet" at boot is pending, not false
 * — a bootstrap that treats it as final strands the user in an
 * unclaimed workspace with no rooms and a guide that never speaks
 * (verbatim the fresh-MacBook screenshot).
 */

const CLI = path.resolve(__dirname, "../../fez-relay/dist/cli.js");

function blankState() {
  let stored: string | undefined;
  setStatePersistence({
    exists: () => stored !== undefined,
    read: () => stored,
    write: (t: string) => {
      stored = t;
    },
  });
}

function spawnRelay(port: number, owner: string): ChildProcess {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fez-coldstart-")), "events.jsonl");
  return spawn("node", [CLI, "--port", String(port), "--store", store, "--owner", owner, "--name", "cold start"], {
    stdio: "ignore",
  });
}

async function waitForNip11(port: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}`, { headers: { Accept: "application/nostr+json" } })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("relay never came up");
}

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill();
});

async function bootAndBootstrap(port: number, ownerHex: string): Promise<{ client: InstanceType<typeof FezClient>; ready: boolean; wire: BrowserWire }> {
  const wire = new BrowserWire([`ws://127.0.0.1:${port}`], ownerHex);
  const client = new FezClient(wire);
  await client.start();
  const ready = await ensureOwnerBootstrap(client);
  return { client, ready, wire };
}

describe("cold start — claimed workspace, a room, and a guide that speaks", () => {
  it("relay already up: boot converges to #general + opener", async () => {
    blankState();
    const sk = generateSecretKey();
    const owner = getPublicKey(sk);
    const relay = spawnRelay(7912, owner);
    children.push(relay);
    await waitForNip11(7912);

    const { client, ready, wire } = await bootAndBootstrap(7912, bytesToHex(sk));
    expect(ready).toBe(true);
    expect(client.state.isOwner(client.pubkey)).toBe(true);
    const general = client.state.workspace.channels.get("bootstrap-general");
    expect(general?.name).toBe("general");
    // Land IN a room, not beside it: a fresh owner staring at
    // "no channel — pick one from the rail" is the bug, not a state.
    // #welcome now exists too on a fresh workspace, and outranks
    // #general as the landing spot — it's the guided room.
    expect(client.state.scope?.channelId).toBe("bootstrap-welcome");

    // The welcome layer over the same relay: the agent key posts the
    // scripted opener into the room the bootstrap just made.
    const agentSk = generateSecretKey();
    const agentWire = new BrowserWire([`ws://127.0.0.1:7912`], bytesToHex(agentSk));
    const marker: MarkerWire = {
      existing: async (channelId) =>
        (await agentWire.query([{ kinds: [47103], "#h": [channelId], limit: 500 }])).map((e) => ({
          tags: e.tags,
          content: e.content,
        })),
      publish: (tmpl) => agentWire.publish(tmpl),
    };
    const posted = await ensureMarkedMessage(
      marker,
      general!.id,
      client.pubkey,
      OPENER_MARKER,
      openerText({ authed: false, runner: false }, "Ken")
    );
    expect(posted).toBe(true);
    const seen = await agentWire.query([{ kinds: [47103], "#h": [general!.id] }]);
    expect(seen.some((e) => e.content.includes("I'm @fez, your guide"))).toBe(true);

    // On the WIRE is not on the SCREEN. The opener above was signed by
    // an unrostered agent key, and the client's trust rule (messages
    // render only from members) rightly refuses it — which was exactly
    // the fresh-install bug: @fez DID speak, invisibly. Raw wire
    // queries bypass that rule; client.messages() is what renders.
    await client.loadChannelHistory(general!.id);
    const visible = () => client.messages(general!.id).some((m) => m.content.includes("I'm @fez, your guide"));
    expect(visible()).toBe(false);

    // Roster the guide as a bot — the welcome flow's required step —
    // and the SAME stored event renders on the next history load
    // (which is also how an already-broken install heals on relaunch).
    const agentPk = getPublicKey(agentSk);
    await client.invite(agentPk, "bot");
    // the roster lands via the subscription echo — wait for membership
    for (let i = 0; i < 20 && !client.state.isMember(agentPk); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.state.isMember(agentPk)).toBe(true);
    await client.loadChannelHistory(general!.id);
    expect(visible()).toBe(true);

    agentWire.close();
    wire.close();
  }, 30_000);

  it("relay coming up LATE still converges — no owner yet is pending, not false", async () => {
    blankState();
    const sk = generateSecretKey();
    const owner = getPublicKey(sk);

    // Boot FIRST; the relay binds ~1.5s later — the fresh-install race.
    const bootPromise = bootAndBootstrap(7913, bytesToHex(sk));
    await new Promise((r) => setTimeout(r, 1500));
    const relay = spawnRelay(7913, owner);
    children.push(relay);
    await waitForNip11(7913);

    const { client, ready, wire } = await bootPromise;
    expect(ready).toBe(true);
    expect(client.state.isOwner(client.pubkey)).toBe(true);
    expect(client.state.workspace.channels.get("bootstrap-general")?.name).toBe("general");
    wire.close();
  }, 40_000);

  it("creates #welcome and lands scope in it", async () => {
    blankState();
    const sk = generateSecretKey();
    const owner = getPublicKey(sk);
    const relay = spawnRelay(7914, owner);
    children.push(relay);
    await waitForNip11(7914);

    const { client, ready, wire } = await bootAndBootstrap(7914, bytesToHex(sk));
    expect(ready).toBe(true);
    expect(client.state.workspace.channels.has("bootstrap-welcome")).toBe(true);
    expect(client.state.workspace.channels.get("bootstrap-welcome")?.name).toBe("welcome");
    expect(client.state.scope?.channelId).toBe("bootstrap-welcome");
    wire.close();
  }, 30_000);
});
