#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execSync, spawn } from "node:child_process";
import {
  CapabilityClient,
  RelayConnection,
  getKey,
  resolveRelay,
  DM_FUZZ_WINDOW_S,
  KIND_AGENT_METADATA,
  KIND_AGENT_ATTESTATION,
  KIND_CHANNEL_MESSAGE,
  KIND_DOC_COMMENT,
  KIND_MEMBERSHIP,
  KIND_GIFT_WRAP,
  KIND_OBSERVER,
} from "@fez/protocol";

/**
 * fez-sentinel — the always-on half of fez, extracted from the TUI so
 * the fleet works with no window open (Buzz's shape: buzz-acp is a
 * standing daemon and docker restarts it; here the smart inner program
 * is this service and the babysitter is whatever the operator has —
 * the herdr plugin, launchd, a shell). Run with `fez sentinel`.
 *
 * Duties (all relay-subscription-driven — the relay is the only
 * control plane, there is no client→sentinel command channel):
 *   - DM summons: kind-1059 gift wraps addressed to a local persona's
 *     pubkey wake it (sender/content/depth are encrypted — spawning is
 *     speculative; the agent gates the DM, idleExit reaps mistakes).
 *   - Mention summons: @name from the owner or an attested sibling
 *     spawns the persona into the mentioned channel, invites it when
 *     its 47000 appears, and attests it as a sibling.
 *   - Desktop notifications: DMs to the owner, mentions of the owner,
 *     failed agent turns — via herdr's notification.show, falling back
 *     to macOS osascript.
 *
 * Spawning goes through herdr when its socket answers (tab per agent,
 * shared ~/.fez/herdr-tabs.json registry — the TUI sidebar keeps
 * showing them); otherwise a detached `fez agent` child with logs in
 * ~/.fez/logs/. A pidfile at ~/.fez/sentinel.pid lets the TUI
 * extensions defer to the sentinel instead of double-firing.
 */

const HERDR_SOCKET = path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const REGISTRY = path.join(os.homedir(), ".fez", "herdr-tabs.json");
const PIDFILE = path.join(os.homedir(), ".fez", "sentinel.pid");
const LOG_DIR = path.join(os.homedir(), ".fez", "logs");
const MAX_CHAIN_DEPTH = 5;

// ── herdr socket (one request per connection, same shape as fez-herdr) ──
function herdrCall(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(HERDR_SOCKET);
    let buf = "";
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, buf.indexOf("\n")));
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result ?? {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    sock.on("connect", () => sock.write(JSON.stringify({ id: "sentinel", method, params }) + "\n"));
    setTimeout(() => {
      sock.destroy();
      reject(new Error("herdr socket timeout"));
    }, 4000).unref?.();
  });
}

let herdrAliveCache: { verdict: boolean; at: number } = { verdict: false, at: 0 };
async function herdrAlive(): Promise<boolean> {
  if (Date.now() - herdrAliveCache.at < 10_000) return herdrAliveCache.verdict;
  const verdict = await herdrCall("ping", {}).then(() => true).catch(() => false);
  herdrAliveCache = { verdict, at: Date.now() };
  return verdict;
}

// ── notifications: herdr toast, else macOS ──────────────────────────────
let lastNotifyAt = 0;
function deliver(title: string, body: string): void {
  const now = Date.now();
  if (now - lastNotifyAt < 2000) return; // flood guard
  lastNotifyAt = now;
  void herdrCall("notification.show", { title, body, sound: "request" })
    .then((result) => {
      if ((result as { shown?: boolean }).shown === false) throw new Error("herdr notifications disabled");
    })
    .catch(() => {
      if (process.platform !== "darwin") return;
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
    });
}

// ── registry shared with the fez-herdr TUI extension ────────────────────
interface RegisteredTab {
  persona: string;
  channels: string[];
  tabId: string;
  paneId: string;
}
function loadRegistry(): RegisteredTab[] {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, "utf-8")) as (RegisteredTab & { channel?: string })[];
    return raw.map((t) => ({ ...t, channels: t.channels ?? (t.channel ? [t.channel] : []) }));
  } catch {
    return [];
  }
}
function saveRegistry(tabs: RegisteredTab[]): void {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(tabs, null, 2), "utf-8");
}

// ── persona/process facts ───────────────────────────────────────────────
function personaExists(name: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".fez", "personas", `${name}.md`), "utf-8");
    const harness = raw.match(/^harness:\s*(.+)$/m)?.[1]?.trim();
    return harness !== undefined && harness !== "router";
  } catch {
    return false;
  }
}
function agentProcessAlive(persona: string): boolean {
  try {
    execSync(`pgrep -f "(fez|cli\\.js) agent ${persona}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const keyHex = getKey("default");
  if (!keyHex) {
    console.error("No fez identity (fez keygen first) — the sentinel signs invites/attestations as you.");
    process.exit(1);
  }
  const relayUrl = process.env.FEZ_RELAY || resolveRelay(undefined);
  const client = new CapabilityClient({ relay: relayUrl, privateKey: keyHex });
  const relay = new RelayConnection({ url: relayUrl, authSigner: client.authSigner });
  await relay.connect();
  const myPubkey = client.getPubkey();

  fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
  fs.writeFileSync(PIDFILE, String(process.pid));
  const cleanup = () => {
    try {
      if (fs.readFileSync(PIDFILE, "utf-8").trim() === String(process.pid)) fs.unlinkSync(PIDFILE);
    } catch { /* already gone */ }
  };
  process.on("SIGINT", () => { cleanup(); relay.disconnect(); console.log("\n🔴 sentinel stopped."); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  console.log(`🛡  fez sentinel on ${relayUrl} (owner ${myPubkey.slice(0, 12)}…)`);
  console.log(`   herdr: ${(await herdrAlive()) ? "connected — agents spawn as tabs" : "absent — agents spawn as detached processes"}`);

  // ── spawn paths ───────────────────────────────────────────────────────
  const agentEnvCmd = (persona: string, channels: string[]) =>
    `FEZ_AGENT_OWNER=${myPubkey} FEZ_RELAY=${relayUrl} fez agent ${persona} -c ${channels.length > 0 ? channels.join(",") : "none"}`;

  async function spawnAgent(persona: string, channels: string[]): Promise<void> {
    if (await herdrAlive()) {
      const registered = loadRegistry();
      const prior = registered.find((t) => t.persona === persona);
      if (prior) await herdrCall("tab.close", { tab_id: prior.tabId }).catch(() => {});
      const created = await herdrCall("tab.create", { label: `fez:${persona}`, cwd: os.homedir(), focus: false });
      const tab = created.tab as { tab_id: string };
      const pane = created.root_pane as { pane_id: string };
      await herdrCall("pane.send_text", { pane_id: pane.pane_id, text: agentEnvCmd(persona, channels) + "\n" });
      saveRegistry([...registered.filter((t) => t.persona !== persona), { persona, channels, tabId: tab.tab_id, paneId: pane.pane_id }]);
      console.log(`🧬 spawned @${persona} in herdr tab ${tab.tab_id} (${channels.length > 0 ? channels.join(",") : "dm-only"})`);
    } else {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const log = fs.openSync(path.join(LOG_DIR, `${persona}.log`), "a");
      const child = spawn("fez", ["agent", persona, "-c", channels.length > 0 ? channels.join(",") : "none"], {
        env: { ...process.env, FEZ_AGENT_OWNER: myPubkey, FEZ_RELAY: relayUrl },
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.unref();
      console.log(`🧬 spawned @${persona} detached (pid ${child.pid}, log ~/.fez/logs/${persona}.log)`);
    }
  }

  // ── rosters ───────────────────────────────────────────────────────────
  const agentPkToName = new Map<string, string>(); // pubkey -> announced name
  const attestedSiblings = new Set<string>();
  const attested = new Set<string>();
  const nameOf = (pk: string) => agentPkToName.get(pk) ?? `${pk.slice(0, 8)}…`;

  function buildTaskNostr() {
    return {
      pubkey: myPubkey,
      publish: async (template: unknown) => {
        const event = client.signEvent(template as never);
        await relay.publish(event);
        return event;
      },
      subscribe: (filters: unknown, handler: unknown) => relay.subscribe(filters as never, handler as never),
      query: (filters: unknown) => relay.query(filters as never),
      encrypt: (peer: string, plaintext: string) => client.encryptTo(peer, plaintext),
      decrypt: (peer: string, ciphertext: string) => client.decryptFrom(peer, ciphertext),
    };
  }

  function attestAgent(agentPubkey: string): void {
    if (attested.has(agentPubkey) || agentPubkey === myPubkey) return;
    attested.add(agentPubkey);
    attestedSiblings.add(agentPubkey);
    void relay
      .publish(client.signEvent({ kind: KIND_AGENT_ATTESTATION, tags: [["p", agentPubkey]], content: "" }))
      .catch(() => attested.delete(agentPubkey));
  }

  async function inviteToChannel(agentPubkey: string, channelId: string, communityId: string): Promise<void> {
    const memberships = await relay.query([{ kinds: [KIND_MEMBERSHIP], "#d": [channelId] }]);
    const latest = memberships.sort((a, b) => a.created_at - b.created_at).at(-1);
    const ptags = latest?.tags.filter((t) => t[0] === "p") ?? [];
    if (ptags.some((t) => t[1] === agentPubkey)) return;
    ptags.push(["p", agentPubkey, "bot"]);
    await relay.publish(
      client.signEvent({ kind: KIND_MEMBERSHIP, tags: [["d", channelId], ["c", communityId], ...ptags], content: "" })
    );
  }

  const [metadataEvents, attestations] = await Promise.all([
    relay.query([{ kinds: [KIND_AGENT_METADATA], limit: 200 }]),
    relay.query([{ kinds: [KIND_AGENT_ATTESTATION], authors: [myPubkey] }]),
  ]);
  for (const event of metadataEvents) {
    try {
      const name = JSON.parse(event.content).name?.toLowerCase();
      if (name) agentPkToName.set(event.pubkey, name);
    } catch { /* ignore */ }
  }
  for (const event of attestations) {
    const pk = event.tags.find((t) => t[0] === "p")?.[1];
    if (pk) attestedSiblings.add(pk);
  }
  console.log(`   roster: ${agentPkToName.size} announced agent(s), ${attestedSiblings.size} attested sibling(s)`);

  // ── watchers ──────────────────────────────────────────────────────────
  const spawning = new Set<string>();
  const pendingInvites = new Map<string, { channelId: string; communityId: string }>();
  const seenDmIds = new Set<string>();
  const sessionStartS = Math.floor(Date.now() / 1000);
  let dmWatchLive = false;
  setTimeout(() => { dmWatchLive = true; }, 5000).unref?.();

  function summon(persona: string, channels: string[], why: string): void {
    if (spawning.has(persona) || !personaExists(persona) || agentProcessAlive(persona)) return;
    spawning.add(persona);
    console.log(`✨ ${why} → summoning @${persona}`);
    void spawnAgent(persona, channels)
      .then(() => spawning.delete(persona))
      .catch((err) => {
        spawning.delete(persona);
        console.error(`⚠️  couldn't summon @${persona}: ${err instanceof Error ? err.message : err}`);
      });
  }

  relay.subscribe(
    [
      { kinds: [KIND_CHANNEL_MESSAGE], since: sessionStartS },
      { kinds: [KIND_DOC_COMMENT], since: sessionStartS },
      { kinds: [KIND_AGENT_METADATA], since: sessionStartS },
      { kinds: [KIND_GIFT_WRAP], since: sessionStartS - DM_FUZZ_WINDOW_S },
      { kinds: [KIND_OBSERVER], "#p": [myPubkey] },
    ],
    (event) => {
      if (event.kind === KIND_AGENT_METADATA) {
        let name: string | undefined;
        try {
          name = JSON.parse(event.content).name?.toLowerCase();
        } catch { return; }
        if (!name) return;
        agentPkToName.set(event.pubkey, name);
        if (loadRegistry().some((t) => t.persona === name)) attestAgent(event.pubkey);
        const target = pendingInvites.get(name);
        if (target) {
          pendingInvites.delete(name);
          attestAgent(event.pubkey);
          void inviteToChannel(event.pubkey, target.channelId, target.communityId)
            .then(() => console.log(`🤝 @${name} announced — invited to its channel`))
            .catch(() => console.warn(`⚠️  invite for @${name} failed`));
        }
        return;
      }

      // Doc comments (40101): a comment that @mentions an agent is work
      // handed over inside a document — same summons authority as chat,
      // but the agent answers in the doc, never in the channel.
      if (event.kind === KIND_DOC_COMMENT) {
        if (event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey)) {
          deliver(`@${nameOf(event.pubkey)} commented on a doc`, event.content.slice(0, 90));
        }
        if (event.pubkey !== myPubkey && !attestedSiblings.has(event.pubkey)) return;
        const channelId = event.tags.find((t) => t[0] === "h")?.[1];
        const communityId = event.tags.find((t) => t[0] === "c")?.[1];
        if (!channelId || !communityId) return;
        for (const match of event.content.matchAll(/@([\w-]+)/g)) {
          const persona = match[1].toLowerCase();
          if (spawning.has(persona) || !personaExists(persona) || agentProcessAlive(persona)) continue;
          pendingInvites.set(persona, { channelId, communityId });
          summon(persona, [channelId], `doc comment by ${nameOf(event.pubkey)}`);
        }
        return;
      }

      if (event.kind === KIND_CHANNEL_MESSAGE) {
        // Mention-of-owner notification (someone else p-tagged us).
        if (event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey)) {
          deliver(`@${nameOf(event.pubkey)} mentioned you`, event.content.slice(0, 90));
        }
        // Summons authority: the owner and attested siblings only.
        if (event.pubkey !== myPubkey && !attestedSiblings.has(event.pubkey)) return;
        if (Number(event.tags.find((t) => t[0] === "depth")?.[1] ?? 0) >= MAX_CHAIN_DEPTH) return;
        const channelId = event.tags.find((t) => t[0] === "h")?.[1];
        const communityId = event.tags.find((t) => t[0] === "c")?.[1];
        if (!channelId || !communityId) return;
        for (const match of event.content.matchAll(/@([\w-]+)/g)) {
          const persona = match[1].toLowerCase();
          if (spawning.has(persona) || !personaExists(persona)) continue;
          if (agentProcessAlive(persona)) {
            // Running, but summoned into a channel it doesn't serve:
            // restart with the union — one process per persona.
            const entry = loadRegistry().find((t) => t.persona === persona);
            if (entry && !entry.channels.includes(channelId)) {
              spawning.add(persona);
              pendingInvites.set(persona, { channelId, communityId });
              console.log(`🔁 pulling @${persona} into a new channel (restart with union)`);
              try { execSync(`pkill -f "(fez|cli\\.js) agent ${persona}"`, { stdio: "pipe" }); } catch { /* already gone */ }
              void spawnAgent(persona, [...entry.channels, channelId])
                .then(() => spawning.delete(persona))
                .catch(() => spawning.delete(persona));
            }
            continue;
          }
          pendingInvites.set(persona, { channelId, communityId });
          summon(persona, [channelId], `mention by ${nameOf(event.pubkey)}`);
        }
        return;
      }

      if (event.kind === KIND_GIFT_WRAP) {
        if (!dmWatchLive) return; // replayed history — agents ignore stale DMs anyway
        const recipient = event.tags.find((t) => t[0] === "p")?.[1];
        if (!recipient) return;
        if (recipient === myPubkey) {
          const dm = client.unwrapDm(event);
          if (dm && dm.senderPk !== myPubkey && dm.ts >= sessionStartS && !seenDmIds.has(dm.id)) {
            seenDmIds.add(dm.id);
            deliver(`✉️ DM from ${nameOf(dm.senderPk)}`, dm.text.slice(0, 90));
          }
          return;
        }
        const persona = agentPkToName.get(recipient);
        if (!persona) return;
        const prior = loadRegistry().find((t) => t.persona === persona);
        summon(persona, prior?.channels ?? [], "DM for a sleeping agent");
        return;
      }

      // Observer frame — failed turns rate a toast.
      try {
        const frame = JSON.parse(client.decryptFrom(event.pubkey, event.content)) as { type?: string; status?: string };
        if (frame.type === "turn" && frame.status === "failed") {
          const agent = event.tags.find((t) => t[0] === "agent")?.[1] ?? nameOf(event.pubkey);
          deliver(`⚠️ @${agent} turn failed`, "Check its herdr tab / ~/.fez/logs for the failure notice.");
        }
      } catch { /* not ours */ }
    }
  );

  // ── Scheduled messages (40006) + reminders (40007): the TUI records
  // the intent; we execute at the appointed time — publish the real
  // channel message (signed as the owner, whose key we run with) or
  // fire the notification — then tombstone the intent (kind 5) so a
  // restart never refires it. Overdue intents (we were down) fire
  // immediately on hydrate.
  const KIND_SCHEDULED = 40006;
  const KIND_REMINDER = 40007;
  const KIND_CHANNEL_MSG = 47103;
  const armedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const firedIntents = new Set<string>();

  type IntentEvent = { id: string; kind: number; content: string; tags: string[][] };

  // Reminders (40007) arrive NIP-44 self-encrypted — note, fire time, and
  // subject in the ciphertext (they're private data on a public relay).
  // We hold the same key, so decrypt to arm. Legacy plaintext reminders
  // (remind_at tag + cleartext note) still decode via the fallback.
  function decodeReminder(intent: IntentEvent): { note: string; at: number } {
    try {
      const payload = JSON.parse(client.decryptFrom(myPubkey, intent.content)) as { note?: string; remind_at?: number };
      if (typeof payload.remind_at === "number") {
        return { note: payload.note || "(reminder)", at: payload.remind_at };
      }
    } catch { /* legacy plaintext form */ }
    return { note: intent.content || "(reminder)", at: Number(intent.tags.find((t) => t[0] === "remind_at")?.[1]) };
  }

  async function fireIntent(intent: IntentEvent): Promise<void> {
    armedTimers.delete(intent.id);
    if (firedIntents.has(intent.id)) return;
    firedIntents.add(intent.id);
    if (intent.kind === KIND_SCHEDULED) {
      const h = intent.tags.find((t) => t[0] === "h")?.[1];
      const c = intent.tags.find((t) => t[0] === "c")?.[1];
      if (h && c) {
        await relay.publish(client.signEvent({ kind: KIND_CHANNEL_MSG, tags: [["h", h], ["c", c]], content: intent.content }));
        console.log(`⏲ delivered scheduled message to channel ${h.slice(0, 8)}…`);
      }
    } else {
      const { note } = decodeReminder(intent);
      deliver("⏰ reminder", note);
      console.log(`⏰ fired reminder: ${note.slice(0, 60)}`);
    }
    await relay.publish(client.signEvent({ kind: 5, tags: [["e", intent.id]], content: "" })).catch(() => {});
  }

  function armIntent(intent: IntentEvent): void {
    if (firedIntents.has(intent.id) || armedTimers.has(intent.id)) return;
    const at =
      intent.kind === KIND_REMINDER
        ? decodeReminder(intent).at
        : Number(intent.tags.find((t) => t[0] === "send_at")?.[1]);
    if (!at) return;
    const delayMs = Math.min(Math.max(0, at * 1000 - Date.now()), 2 ** 31 - 1);
    armedTimers.set(intent.id, setTimeout(() => void fireIntent(intent), delayMs));
    console.log(`⏲ armed ${intent.kind === KIND_SCHEDULED ? "scheduled message" : "reminder"} (fires in ${Math.round(delayMs / 1000)}s)`);
  }

  relay.subscribe([{ kinds: [KIND_SCHEDULED, KIND_REMINDER], authors: [myPubkey], since: sessionStartS }], (event) =>
    armIntent(event)
  );
  const [intents, tombstones] = await Promise.all([
    relay.query([{ kinds: [KIND_SCHEDULED, KIND_REMINDER], authors: [myPubkey] }]),
    relay.query([{ kinds: [5], authors: [myPubkey] }]),
  ]);
  const dead = new Set(tombstones.flatMap((t) => t.tags.filter((x) => x[0] === "e").map((x) => x[1])));
  for (const intent of intents) if (!dead.has(intent.id)) armIntent(intent);

  // ── extension background tasks ────────────────────────────────────────
  // The sentinel is the only always-on, key-holding host, so it's where
  // an extension's scheduled work belongs (a live block that refreshes
  // itself, a nightly bench run). Extensions get the relay and the
  // owner's identity — no UI, no shell. A task that throws is logged and
  // retried next tick; it can never take the sentinel down.
  await (async () => {
   try {
    const { loadExtensions, registeredScheduledTasks, setNostrBackend, loadSettings } = await import("@fez/protocol");
    setNostrBackend(buildTaskNostr() as never);
    // Only extensions that ASKED for background life (fez.parts.background
    // in their manifest, recorded at install time) run here.
    const background = (loadSettings() as { backgroundExtensions?: string[] }).backgroundExtensions ?? [];
    if (background.length === 0) {
      console.log("   ⏱  no background extensions installed");
      return;
    }
    await loadExtensions(undefined, background);
    const tasks = registeredScheduledTasks();
    for (const task of tasks) {
      const everyMs = Math.max(60_000, task.everyMs);
      let lastTickAt = Date.now();
      const tick = async () => {
        // A gap far longer than the interval means the machine slept.
        const missedWindow = Date.now() - lastTickAt > everyMs * 2;
        lastTickAt = Date.now();
        try {
          await task.run({ nostr: buildTaskNostr(), ownerPubkey: myPubkey, missedWindow });
        } catch (err) {
          console.warn(`⚠️  scheduled task "${task.name}" failed: ${err instanceof Error ? err.message : err}`);
        }
      };
      const timer = setInterval(() => void tick(), everyMs);
      timer.unref?.();
      void tick(); // once at boot: a due block shouldn't wait a full interval
      console.log(`   ⏱  scheduled task "${task.name}" every ${Math.round(everyMs / 60_000)}m`);
    }
   } catch (err) {
    console.warn(`⚠️  extension tasks unavailable: ${err instanceof Error ? err.message : err}`);
   }
  })();

  console.log(`   watching: DM summons · mention summons · doc-comment summons · notifications · schedules/reminders. Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
