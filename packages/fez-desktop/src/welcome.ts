/**
 * Wires welcome-core to the running app: ensures the @fez persona and
 * its local agent key exist, computes readiness from what this machine
 * actually has, and posts the scripted opener (and later the awake
 * line) signed by the agent key. The persona text is a desktop-owned
 * duplicate of the CLI's starter @fez (src/identity/fez-persona.ts is
 * the source of truth) — the bundle deliberately doesn't import the CLI.
 */
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import { BrowserWire, rustSigner } from "./wire";
import { relaySet } from "./relay";
import { toast } from "./toast";
import { agentReady, detectHarnesses, localAgents, type LocalAgentStatus } from "./harnesses";
import { PROVIDERS, providerId } from "./providers";
import {
  WELCOME_CHANNEL_ID,
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
  shouldPublishMarked,
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

/** Readiness belongs to the chosen persona, never another installed agent. */
export async function readiness(): Promise<Readiness> {
  try {
    const md = await invoke<string>("read_persona", { name: "fez" });
    const brain = parsePersonaBrain(md);
    const local = localAgents.find((a) => a.id === brain.harness);
    if (local) {
      const status = JSON.parse(await invoke<string>(local.statusCommand)) as LocalAgentStatus;
      return { authed: agentReady(status), runner: true };
    }
    if (brain.harness !== "pi" || !brain.provider || !brain.model) return { authed: false, runner: true };
    const id = providerId(brain.provider);
    const harnesses = await detectHarnesses();
    const authed = !!harnesses.pi && PROVIDERS.some((p) => p.id === id)
      && await invoke<boolean>("provider_key_present", { provider: id });
    return { authed, runner: true };
  } catch {
    return { authed: false, runner: true };
  }
}

function markerWire(pubkey: string): MarkerWire & { close(): void } {
  const wire = new BrowserWire(relaySet(), rustSigner(pubkey, AGENT_ACCOUNT));
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

/** Create and start the welcome teammates without overwriting existing personas. */
async function prepareStarterTeam(client: FezClient, channelId: string): Promise<void> {
  const fezMd = await invoke<string>("read_persona", { name: "fez" }).catch(() => "");
  const brain = parsePersonaBrain(fezMd);
  for (const p of STARTER_TEAM) {
    try {
      await invoke("read_persona", { name: p.id });
    } catch {
      await invoke("write_persona", {
        name: p.id,
        content: buildStarterPersonaMd(p, brain.harness, brain.model, brain.provider, brain.effort),
      });
    }
  }

  const owner = client.pubkey;
  const relay = relaySet()[0];
  for (const p of STARTER_TEAM) {
    // Same custody as @fez: keychain fez-keys / agent:<name> — the key the
    // spawned fez-agent will load is the key we roster here.
    let pk: string;
    try {
      pk = await invoke<string>("ensure_agent_identity", { name: p.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.warn(`@${p.id} skipped: ${msg}`);
      continue;
    }
    if (!client.state.isMember(pk)) {
      await client.invite(pk, "bot").catch(() => {});
      await client.attestAgent(pk).catch(() => {});
    }
    // Surface a failed spawn (summoner.ts learned this first): swallowed,
    // the teammate greets via the scripted opener and then never answers
    // a mention — indistinguishable from a working agent until you talk
    // to it. The welcome itself continues; the toast says who's down.
    await invoke("start_managed_agent", { persona: p.id, owner, relay, channels: `${channelId},bootstrap-general` }).catch((err) => {
      toast.error(`@${p.id} couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

async function ensureStarterTeam(client: FezClient, w: MarkerWire, channelId: string, guidePk: string): Promise<void> {
  await prepareStarterTeam(client, channelId);
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

/**
 * The FirstRun hero's durable copy, as each bootstrap channel's standing
 * info. The hero used to re-render the whole pitch in every empty room;
 * now the workspace introduces itself once in the timeline, and the
 * guide text lives where standing information belongs — the channel doc,
 * collapsible under the title, readable by agents, editable by anyone.
 * Only the durable lines move: readiness and the roster are live facts
 * the timeline owns, and a doc that asserted them would start lying the
 * day they changed.
 */
const GENERAL_DOC_SEED = `# general

@fez is your guide. Ask it anything about fez — how git works, what an extension does, how to set something up — and it answers. Hand it a task and it brings in the right agent.

Try \`@fez what can you do?\` — or ask it to set you up, like \`@fez install polls\` (you confirm before anything installs).

@fez is a persona at \`~/.fez/personas/fez.md\` — swap its \`harness:\` to run it on any model.
`;

const WELCOME_DOC_SEED = `# welcome

Your first room — @fez opened it to say hello and introduce the team. Mention @fez or any teammate, here or anywhere, whenever you want their help.
`;

/** Seed the bootstrap channels' docs, once. NEVER clobbers: a doc with
 * content belongs to the room — history is loaded first so an existing
 * doc the client simply hadn't absorbed yet cannot be overwritten. */
async function seedChannelDocs(client: FezClient): Promise<void> {
  const seeds: [string, string][] = [
    ["bootstrap-general", GENERAL_DOC_SEED],
    [WELCOME_CHANNEL_ID, WELCOME_DOC_SEED],
  ];
  for (const [id, text] of seeds) {
    if (!client.state.workspace.channels.has(id)) continue;
    await client.loadChannelHistory(id).catch(() => {});
    if (client.docsByChannel().get(id)?.latestContent?.trim()) continue;
    await client.publishDoc(id, text).catch(() => {});
  }
}

/** The one call App.tsx makes after the owner bootstrap. */
export async function ensureWelcome(client: FezClient): Promise<void> {
  // Only in a local workspace the user owns; never on joined relays.
  if (!relaySet()[0].startsWith("ws://127.0.0.1")) return;
  if (!client.state.isOwner(client.pubkey)) return;
  // Post into #welcome when it exists; an old install without it keeps
  // its general-channel history honored.
  const channel = client.state.workspace.channels.get(WELCOME_CHANNEL_ID) ?? client.state.workspace.channels.get("bootstrap-general");
  if (!channel) return;

  await seedChannelDocs(client);

  const harnesses = await detectHarnesses();
  await ensureFezPersona(harnesses["claude-code"] ? "claude-code" : "pi");
  const agentPk = await invoke<string>("ensure_agent_identity", { name: "fez" });

  // Roster the guide BEFORE it speaks. The opener is signed by the
  // agent's own key, and the client renders only members — an
  // unrostered @fez posted a perfect welcome that every client rightly
  // refused to show (found live: three events on the relay, a silent
  // screen). Idempotent; owner-signed.
  if (!client.state.isMember(agentPk)) {
    await client.invite(agentPk, "bot").catch(() => {});
    // Attested = summon authority: the sentinel honors mentions from the
    // owner or attested siblings, and the team opener is @fez speaking.
    await client.attestAgent(agentPk).catch(() => {});
  }
  // The guide should answer real mentions, not only post scripted lines.
  // A swallowed failure here was the cruelest first-run outcome: @fez
  // posts its welcome (owner-signed markers, no process needed), then
  // never answers a single mention, with no trace anywhere.
  const r = await readiness();
  if (r.authed) await invoke("start_managed_agent", {
    persona: "fez",
    owner: client.pubkey,
    relay: relaySet()[0],
    channels: `${channel.id},bootstrap-general`,
  }).catch((err) => {
    toast.error(`@fez couldn't start: ${err instanceof Error ? err.message : String(err)}`);
  });

  const userName = localStorage.getItem("fez-name") ?? "";
  const w = markerWire(agentPk);
  try {
    // The author line reads "fez", not a pubkey prefix — kind 0 is
    // replaceable, so republishing the same profile every run is a no-op.
    await w.publish({ kind: 0, tags: [], content: JSON.stringify({ name: "fez" }) }).catch(() => {});

    // Marker idempotency across both rooms: an old install's history
    // lives in #general, a fresh one's in #welcome — query both and
    // merge before any publish, so neither line repeats.
    const welcomeEvents = await w.existing(WELCOME_CHANNEL_ID).catch(() => []);
    const generalEvents = await w.existing("bootstrap-general").catch(() => []);
    const existing = [...welcomeEvents, ...generalEvents];
    if (shouldPublishMarked(existing, OPENER_MARKER)) {
      // A RECEIVED message, not furniture: a typing beat, a short hello,
      // a breath, then the intro — the same rhythm a person would have.
      await w.publish({ kind: KIND_TYPING, tags: [["h", channel.id]], content: "" }).catch(() => {});
      await sleep(1400);
      if (shouldPublishMarked(existing, HELLO_MARKER)) {
        await ensureMarkedMessage(w, channel.id, client.pubkey, HELLO_MARKER, helloText(userName));
      }
      await sleep(900);
      if (shouldPublishMarked(existing, OPENER_MARKER)) {
        await ensureMarkedMessage(w, channel.id, client.pubkey, OPENER_MARKER, openerText(r, userName));
      }
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
        if (opener?.content.includes(NOT_READY_CUE) && !findMarked(existing, AWAKE_MARKER)) {
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
