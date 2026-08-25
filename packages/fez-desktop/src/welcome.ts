/**
 * Wires welcome-core to the running app: ensures the @fez persona and
 * its local agent key exist, computes readiness from what this machine
 * actually has, and posts the scripted opener (and later the awake
 * line) signed by the agent key. The persona text is a desktop-owned
 * duplicate of the CLI's starter @fez (src/identity/fez-persona.ts is
 * the source of truth) — the bundle deliberately doesn't import the CLI.
 */
import { invoke } from "@tauri-apps/api/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { FezClient } from "@fezchat/client";
import { BrowserWire } from "./wire";
import { relaySet } from "./relay";
import {
  OPENER_MARKER,
  AWAKE_MARKER,
  KIND_MESSAGE,
  NOT_READY_CUE,
  openerText,
  awakeText,
  ensureMarkedMessage,
  findMarked,
  type Readiness,
  type MarkerWire,
} from "./welcome-core";

const AGENT_ACCOUNT = "agent:fez";

const FEZ_PERSONA_MD = `---
harness: {{HARNESS}}
aliases: [orchestrator]
description: your guide to fez — ask how anything works, or hand over a task and the right agent gets it
---
You are @fez, the guide for this fez workspace. Answer questions about fez
plainly; for tasks, name the persona best suited and offer to bring it in.
`;

async function ensureFezPersona(harness: string): Promise<void> {
  try {
    await invoke("read_persona", { name: "fez" });
  } catch {
    await invoke("write_persona", { name: "fez", content: FEZ_PERSONA_MD.replace("{{HARNESS}}", harness) });
  }
}

async function agentKeyHex(): Promise<string> {
  try {
    return await invoke<string>("get_identity", { account: AGENT_ACCOUNT });
  } catch {
    const hex = bytesToHex(generateSecretKey());
    await invoke("set_identity", { hex, account: AGENT_ACCOUNT });
    return hex;
  }
}

export async function readiness(): Promise<Readiness> {
  const harnesses = await invoke<Record<string, boolean>>("detect_harnesses").catch(() => ({}) as Record<string, boolean>);
  const chutes = await invoke<boolean>("has_skill_secret", { skill: "chutes", key: "CHUTES_API_KEY" }).catch(() => false);
  const runner = await invoke<boolean>("runner_status").catch(() => false);
  return { authed: !!harnesses["claude-code"] || (!!harnesses["pi"] && chutes), runner };
}

function markerWire(hex: string): MarkerWire & { close(): void } {
  const wire = new BrowserWire(relaySet(), hex);
  return {
    async existing(channelId) {
      const events = await wire.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], limit: 500 }]);
      return (events as { tags: string[][]; content: string }[]).map((e) => ({ tags: e.tags, content: e.content }));
    },
    publish: (tmpl) => wire.publish(tmpl),
    close: () => wire.close(),
  };
}

/** The one call App.tsx makes after the owner bootstrap. */
export async function ensureWelcome(client: FezClient): Promise<void> {
  // Only in a local workspace the user owns; never on joined relays.
  if (!relaySet()[0].startsWith("ws://127.0.0.1")) return;
  if (!client.state.isOwner(client.pubkey)) return;
  const channel = client.state.workspace.channels.get("bootstrap-general");
  if (!channel) return;

  const harnesses = await invoke<Record<string, boolean>>("detect_harnesses").catch(() => ({}) as Record<string, boolean>);
  await ensureFezPersona(harnesses["claude-code"] ? "claude-code" : "pi");
  const hex = await agentKeyHex();

  // Roster the guide BEFORE it speaks. The opener is signed by the
  // agent's own key, and the client renders only members — an
  // unrostered @fez posted a perfect welcome that every client rightly
  // refused to show (found live: three events on the relay, a silent
  // screen). Idempotent; owner-signed.
  const agentPk = getPublicKey(hexToBytes(hex));
  if (!client.state.isMember(agentPk)) {
    await client.invite(agentPk, "bot").catch(() => {});
  }

  const r = await readiness();
  const userName = localStorage.getItem("fez-name") ?? "";
  const w = markerWire(hex);
  try {
    const posted = await ensureMarkedMessage(w, channel.id, client.pubkey, OPENER_MARKER, openerText(r, userName));
    if (!posted) {
      // The opener already exists on the relay — an install from before
      // the roster fix. Now that the agent is a member, one history
      // reload makes the stored opener render in THIS session.
      await client.loadChannelHistory(channel.id).catch(() => {});
    }
    // The awake line only ever follows a NOT-ready opener whose gap has
    // since been filled — cued by the opener's own text, so a ready-day-one
    // opener never grows a spurious "I'm awake" on a later launch.
    if (!posted && r.authed && r.runner) {
      const opener = findMarked(await w.existing(channel.id), OPENER_MARKER);
      if (opener?.content.includes(NOT_READY_CUE)) {
        await ensureMarkedMessage(w, channel.id, client.pubkey, AWAKE_MARKER, awakeText());
      }
    }
  } finally {
    w.close();
  }
}
