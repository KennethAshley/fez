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
  HELLO_MARKER,
  OPENER_MARKER,
  AWAKE_MARKER,
  TEAM_MARKER,
  KICKOFF_MARKER,
  KIND_MESSAGE,
  NOT_READY_CUE,
  STARTER_TEAM,
  helloText,
  openerText,
  awakeText,
  teamOpenerText,
  kickoffText,
  buildStarterPersonaMd,
  parsePersonaBrain,
  introCount,
  ensureMarkedMessage,
  findMarked,
  type Readiness,
  type MarkerWire,
} from "./welcome-core";

/** Typing kind — mirrors K.TYPING in @fezchat/client. Ephemeral. */
const KIND_TYPING = 20002;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AGENT_ACCOUNT = "agent:fez";

async function ensureFezPersona(harness: string): Promise<void> {
  try {
    await invoke("read_persona", { name: "fez" });
  } catch {
    // Fallback shape only — the onboarding brain step writes a richer
    // one (with the chosen model) BEFORE this runs, and existing files
    // are never overwritten.
    const { buildFezPersonaMd } = await import("./welcome-core");
    await invoke("write_persona", { name: "fez", content: buildFezPersonaMd(harness) });
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
      return (events as { tags: string[][]; content: string; pubkey: string }[]).map((e) => ({
        tags: e.tags,
        content: e.content,
        pubkey: e.pubkey,
      }));
    },
    publish: (tmpl) => wire.publish(tmpl),
    close: () => wire.close(),
  };
}

/**
 * The welcome becomes a team (Buzz's kickoff, fez-cast): create the
 * starter personas with the brain @fez was given, have @fez summon them
 * by mention — REAL turns, woken by the sentinel — then, once they've
 * introduced themselves (or the backstop passes), ask the question the
 * whole room exists for. Idempotent at every step: personas are never
 * overwritten, both messages are relay-marked.
 */
async function ensureStarterTeam(
  client: FezClient,
  w: MarkerWire,
  channelId: string,
  guidePk: string
): Promise<void> {
  const fezMd = await invoke<string>("read_persona", { name: "fez" }).catch(() => "");
  const brain = parsePersonaBrain(fezMd);
  for (const p of STARTER_TEAM) {
    try {
      await invoke("read_persona", { name: p.id });
    } catch {
      await invoke("write_persona", {
        name: p.id,
        content: buildStarterPersonaMd(p, brain.harness, brain.model, brain.provider),
      });
    }
  }

  const teamPosted = await ensureMarkedMessage(
    w,
    channelId,
    client.pubkey,
    TEAM_MARKER,
    teamOpenerText(STARTER_TEAM.map((p) => p.id))
  );
  if (teamPosted) await new Promise((r) => setTimeout(r, 2000));

  // The kickoff lands as the conversation's next beat: wait for both
  // intros, but never forever — a teammate that failed to wake already
  // reported loudly in-channel (fez-acp's rule), and the question still
  // deserves asking.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const events = await w.existing(channelId);
    if (findMarked(events, KICKOFF_MARKER)) return; // another device got there
    if (introCount(events, guidePk, client.pubkey) >= STARTER_TEAM.length) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  await ensureMarkedMessage(w, channelId, client.pubkey, KICKOFF_MARKER, kickoffText());
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
    // Attested = summon authority: the sentinel honors mentions from the
    // owner or attested siblings, and the team opener is @fez speaking.
    await client.attestAgent(agentPk).catch(() => {});
  }

  const r = await readiness();
  const userName = localStorage.getItem("fez-name") ?? "";
  const w = markerWire(hex);
  try {
    // The author line reads "fez", not a pubkey prefix — kind 0 is
    // replaceable, so republishing the same profile every run is a no-op.
    await w.publish({ kind: 0, tags: [], content: JSON.stringify({ name: "fez" }) }).catch(() => {});

    const existing = await w.existing(channel.id);
    if (!findMarked(existing, OPENER_MARKER)) {
      // A RECEIVED message, not furniture: a typing beat, a short hello,
      // a breath, then the intro — the same rhythm a person would have.
      await w.publish({ kind: KIND_TYPING, tags: [["h", channel.id]], content: "" }).catch(() => {});
      await sleep(1400);
      await ensureMarkedMessage(w, channel.id, client.pubkey, HELLO_MARKER, helloText(userName));
      await sleep(900);
      await ensureMarkedMessage(w, channel.id, client.pubkey, OPENER_MARKER, openerText(r, userName));
      // A ready guide brings its team: real teammates, real turns.
      if (r.authed && r.runner) {
        await sleep(1200);
        await ensureStarterTeam(client, w, channel.id, agentPk);
      }
    } else {
      // The opener already exists — an install from before the roster
      // fix. Now that the agent is a member, one history reload makes
      // the stored opener render in THIS session.
      await client.loadChannelHistory(channel.id).catch(() => {});
      // The awake line only ever follows a NOT-ready opener whose gap
      // has since been filled — cued by the opener's own text, so a
      // ready-day-one opener never grows a spurious "I'm awake" later.
      if (r.authed && r.runner) {
        const opener = findMarked(existing, OPENER_MARKER);
        if (opener?.content.includes(NOT_READY_CUE)) {
          await ensureMarkedMessage(w, channel.id, client.pubkey, AWAKE_MARKER, awakeText());
        }
        // The team arrives whenever readiness does — day one, or the day
        // the model got connected. Marker-idempotent, and this branch
        // also resumes a kickoff the last session quit before posting.
        await ensureStarterTeam(client, w, channel.id, agentPk);
      }
    }
  } finally {
    w.close();
  }
}
