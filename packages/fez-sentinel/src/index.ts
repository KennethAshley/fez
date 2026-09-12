#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import {
  CapabilityClient,
  RelayConnection,
  getKey,
  resolveRelays,
  watchRelaySet,
  DM_FUZZ_WINDOW_S,
  KIND_AGENT_METADATA,
  KIND_CHANNEL_MESSAGE,
  KIND_DOC_COMMENT,
  KIND_GIFT_WRAP,
  KIND_OBSERVER,
  KIND_PRESENCE,
  isSafeWork,
  parseSealed,
  setWorkspaceBackend,
} from "@fezchat/protocol";
import { assertHeadlessOwnership, backgroundExtensions, prepareBackgroundTasks } from "./background.js";
import { decodeReminderV2 } from "./reminders-v2.js";

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

// Summon policy is now in @fezchat/protocol (shared with desktop)
export { summonMentions, isSafeWork } from "@fezchat/protocol";

export { refreshWorkspace } from "./background.js";

const HERDR_SOCKET = path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const REGISTRY = path.join(os.homedir(), ".fez", "herdr-tabs.json");
const PIDFILE = path.join(os.homedir(), ".fez", "sentinel.pid");
const LOG_DIR = path.join(os.homedir(), ".fez", "logs");

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
  /** Thread-scoped work: the repo + line this instance was cut onto. */
  work?: { repo: string; line?: string };
}
function loadRegistry(file = REGISTRY): RegisteredTab[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as (RegisteredTab & { channel?: string })[];
    return raw.map((t) => ({ ...t, channels: t.channels ?? (t.channel ? [t.channel] : []) }));
  } catch {
    return [];
  }
}

export function registeredAgent(persona: string, home = path.join(os.homedir(), ".fez")) {
  // A desktop-started agent can outlive the app. Its live record must
  // survive the handoff to the sentinel, including its channels/checkout.
  if (!/^[\w-]+$/.test(persona)) return;
  try {
    const rows: unknown = JSON.parse(fs.readFileSync(path.join(home, "desktop-agents.json"), "utf-8"));
    const row = Array.isArray(rows) ? (rows as { persona?: unknown; channels?: unknown; pid?: unknown; bin?: unknown; repo?: unknown; line?: unknown }[])
      .find(entry => entry.persona === persona && (entry.bin === undefined || entry.bin === "fez-agent")) : undefined;
    if (row && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 1 &&
        Array.isArray(row.channels) && row.channels.every((channel): channel is string => typeof channel === "string") &&
        (row.repo === undefined || typeof row.repo === "string" && isSafeWork(row.repo)) &&
        (row.line === undefined || typeof row.line === "string" && isSafeWork(row.line)) &&
        Number(fs.readFileSync(path.join(home, "agents", `${persona}.pid`), "utf-8").trim()) === row.pid) {
      const command = execFileSync("ps", ["-p", String(row.pid), "-o", "command="], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const binary = path.join(home, "bin", "fez-agent");
      if (command === binary || command.startsWith(`${binary} `)) {
        return { channels: row.channels, work: typeof row.repo === "string" ? { repo: row.repo, line: typeof row.line === "string" ? row.line : undefined } : undefined };
      }
    }
  } catch { /* missing, stale, or unreadable desktop record; try the sentinel's registry */ }
  const row = loadRegistry(path.join(home, "herdr-tabs.json")).find((entry) => entry.persona === persona);
  return row ? { channels: row.channels, work: row.work } : undefined;
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

/** Explicit entry point for the CLI; importing pure helpers must not start a daemon. */
export async function runSentinel(onlyExtensions?: readonly string[]) {
  assertHeadlessOwnership();
  const background = backgroundExtensions(onlyExtensions);
  // BEFORE anything shells out. launchd hands this process
  // PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew, uv, cargo and nvm
  // are all invisible — and an extension that shells out reports the
  // tool as "not installed" when it is sitting right there. Adopting the
  // login shell's PATH once fixes every extension at once, including
  // ones written by people who never hit this.
  const { adoptUserPath } = await import("@fezchat/protocol");
  adoptUserPath();

  const keyHex = getKey("default");
  if (!keyHex) {
    console.error("No fez identity (fez keygen first) — the sentinel signs invites/attestations as you.");
    process.exit(1);
  }
  const relayUrls = resolveRelays();
  const client = new CapabilityClient({ relay: relayUrls, privateKey: keyHex });
  const relay = new RelayConnection({ urls: relayUrls, authSigner: client.authSigner });
  await relay.connect();
  const myPubkey = client.getPubkey();

  fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
  fs.writeFileSync(PIDFILE, String(process.pid));
  let backgroundHost: Awaited<ReturnType<typeof prepareBackgroundTasks>> | undefined;
  const cleanup = () => {
    void backgroundHost?.stop();
    try {
      if (fs.readFileSync(PIDFILE, "utf-8").trim() === String(process.pid)) fs.unlinkSync(PIDFILE);
    } catch { /* already gone */ }
  };
  process.on("SIGINT", () => { cleanup(); relay.disconnect(); console.log("\n🔴 sentinel stopped."); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  // Follow the user, not the boot-time snapshot: when the relay set in
  // settings.json changes (the GUI moving into a workspace, `fez relay
  // add`), swap the live connections — "my sentinel is down" was a
  // sentinel faithfully watching a relay the user had left.
  watchRelaySet((next) => {
    try {
      const previousPrimary = relayUrls[0];
      relay.setRelays(next);
      client.setRelays(next);
      relayUrls.length = 0;
      relayUrls.push(...next); // same array — spawn env strings read it live
      if (next[0] !== previousPrimary) setWorkspaceBackend({ relayUrl: next[0] });
      console.log(`🔁 relay set changed → ${next.join(", ")}`);
    } catch (err) {
      console.error(`⚠️  relay set change refused: ${err instanceof Error ? err.message : err}`);
    }
  });

  console.log(`🛡  fez sentinel on ${relayUrls.join(", ")} (owner ${myPubkey.slice(0, 12)}…)`);
  console.log(`   herdr: ${(await herdrAlive()) ? "connected — agents spawn as tabs" : "absent — agents spawn as detached processes"}`);

  // ── spawn paths ───────────────────────────────────────────────────────
  const agentEnvCmd = (persona: string, channels: string[], work?: { repo: string; line?: string }, takeOver = false) => {
    // The SINK: this string is typed into a live shell (herdr
    // pane.send_text). Validating HERE, not only where `work` is built,
    // is what makes the guard hold against a future caller that
    // constructs a work object some other way — the boundary is the
    // shell, so the check lives at the shell. Unsafe input is a bug in
    // the caller, so throw rather than silently drop.
    if (work && !isSafeWork(work.repo)) throw new Error(`unsafe repo name refused: ${work.repo}`);
    if (work?.line && !isSafeWork(work.line)) throw new Error(`unsafe line name refused: ${work.line}`);
    const env =
      `FEZ_AGENT_OWNER=${myPubkey} FEZ_RELAY=${relayUrls.join(",")}` +
      (takeOver ? " FEZ_AGENT_TAKEOVER=1" : "") +
      (work ? ` FEZ_AGENT_REPO=${work.repo}${work.line ? ` FEZ_AGENT_BASE_BRANCH=${work.line}` : ""}` : "");
    // The bundled runtime first: a desktop-only machine has no `fez` on
    // PATH, and the whole point of shipping fez-agent is that summons
    // work there. The runtime reads the same env vars `fez agent` sets.
    const bundled = path.join(os.homedir(), ".fez", "bin", "fez-agent");
    if (fs.existsSync(bundled)) {
      return `${env} FEZ_AGENT_PERSONA=${persona} FEZ_AGENT_CHANNELS=${channels.join(",")} ${bundled}`;
    }
    return `${env} fez agent ${persona} -c ${channels.length > 0 ? channels.join(",") : "none"}`;
  };

  async function spawnAgent(persona: string, channels: string[], work?: { repo: string; line?: string }, takeOver = false): Promise<void> {
    if (await herdrAlive()) {
      const registered = loadRegistry();
      const prior = registered.find((t) => t.persona === persona);
      if (prior) await herdrCall("tab.close", { tab_id: prior.tabId }).catch(() => {});
      const created = await herdrCall("tab.create", { label: `fez:${persona}`, cwd: os.homedir(), focus: false });
      const tab = created.tab as { tab_id: string };
      const pane = created.root_pane as { pane_id: string };
      await herdrCall("pane.send_text", { pane_id: pane.pane_id, text: agentEnvCmd(persona, channels, work, takeOver) + "\n" });
      saveRegistry([...registered.filter((t) => t.persona !== persona), { persona, channels, tabId: tab.tab_id, paneId: pane.pane_id, work }]);
      console.log(`🧬 spawned @${persona} in herdr tab ${tab.tab_id} (${channels.length > 0 ? channels.join(",") : "dm-only"})`);
    } else {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const log = fs.openSync(path.join(LOG_DIR, `${persona}.log`), "a");
      const env = {
        ...process.env,
        FEZ_AGENT_OWNER: myPubkey,
        FEZ_RELAY: relayUrls.join(","),
        ...(takeOver ? { FEZ_AGENT_TAKEOVER: "1" } : {}),
        ...(work ? { FEZ_AGENT_REPO: work.repo, ...(work.line ? { FEZ_AGENT_BASE_BRANCH: work.line } : {}) } : {}),
      };
      const bundled = path.join(os.homedir(), ".fez", "bin", "fez-agent");
      const child = fs.existsSync(bundled)
        ? spawn(bundled, [], {
            env: { ...env, FEZ_AGENT_PERSONA: persona, FEZ_AGENT_CHANNELS: channels.join(",") },
            detached: true,
            stdio: ["ignore", log, log],
          })
        : spawn("fez", ["agent", persona, "-c", channels.length > 0 ? channels.join(",") : "none"], {
            env,
            detached: true,
            stdio: ["ignore", log, log],
          });
      child.unref();
      console.log(`🧬 spawned @${persona} detached (pid ${child.pid}, log ~/.fez/logs/${persona}.log)`);
    }
  }

  // Courtesy half of single ownership (the agent's boot-time yield is
  // the guard): a persona whose key beat presence within the TTL is
  // alive SOMEWHERE — don't spawn a duplicate for it. Advisory only;
  // racing spawners are settled by the agents themselves.
  const PRESENCE_TTL_MS = 90_000;
  const lastBeat = new Map<string, number>();
  relay.subscribe([{ kinds: [KIND_PRESENCE] }], (event) => {
    lastBeat.set(event.pubkey, Date.now());
  });

  async function resolvePersonaPubkey(persona: string): Promise<string | undefined> {
    const { loadOrCreateKey } = await import("@fezchat/protocol");
    const { getPublicKey } = await import("nostr-tools/pure");
    try {
      const hexKey = loadOrCreateKey(`agent:${persona}`);
      return getPublicKey(Uint8Array.from(hexKey.match(/../g)!.map((b) => parseInt(b, 16))));
    } catch {
      return undefined;
    }
  }

  // ── summon engine — policy shared with the desktop host (@fezchat/protocol) ──
  const { SummonEngine } = await import("@fezchat/protocol");
  const engine = new SummonEngine(
    {
      ownerPubkey: myPubkey,
      personaExists,
      personaPubkey: resolvePersonaPubkey,
      agentAlive: async (persona: string) => {
        if (agentProcessAlive(persona)) return true;
        const pk = await resolvePersonaPubkey(persona).catch(() => undefined);
        return !!pk && Date.now() - (lastBeat.get(pk) ?? 0) < PRESENCE_TTL_MS;
      },
      registryEntry: (persona: string) => registeredAgent(persona),
      spawn: (persona, channels, work) => spawnAgent(persona, channels, work),
      restart: async (persona, channels, work) => {
        // Bundled agents have no persona in argv. Let the signed ownership
        // protocol retire the old body instead of guessing which PID to kill.
        await spawnAgent(persona, channels, work, true);
      },
      query: (filters) => relay.query(filters as never) as never,
      publish: async (template) => {
        await relay.publish(client.signEvent(template as never));
      },
      announceTimeout: (persona, channelId) => {
        console.error(`⚠️  @${persona} never started (no announce, no process)`);
        void relay
          .publish(
            client.signEvent({
              kind: KIND_CHANNEL_MESSAGE,
              tags: [["h", channelId]],
              content: `⚠️ \`${persona}\` failed to start — its process died before announcing (check its herdr tab or ~/.fez/logs/${persona}.log)`,
            })
          )
          .catch(() => {});
      },
      log: (line) => console.log(line),
    },
    {}
  );
  await engine.seedRosters();

  // ── watchers ──────────────────────────────────────────────────────────
  const seenDmIds = new Set<string>();
  const sessionStartS = Math.floor(Date.now() / 1000);
  let dmWatchLive = false;
  setTimeout(() => { dmWatchLive = true; }, 5000).unref?.();

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
        void engine.handleEvent(event as never);
        return;
      }
      if (event.kind === KIND_DOC_COMMENT) {
        if (event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey)) {
          deliver(`@${engine.nameOf(event.pubkey)} commented on a doc`, event.content.slice(0, 90));
        }
        void engine.handleEvent(event as never);
        return;
      }
      if (event.kind === KIND_CHANNEL_MESSAGE) {
        if (event.pubkey !== myPubkey && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey)) {
          deliver(`@${engine.nameOf(event.pubkey)} mentioned you`, event.content.slice(0, 90));
        }
        void engine.handleEvent(event as never);
        return;
      }
      if (event.kind === KIND_GIFT_WRAP) {
        if (!dmWatchLive) return;
        const recipient = event.tags.find((t) => t[0] === "p")?.[1];
        if (!recipient) return;
        if (recipient === myPubkey) {
          const dm = client.unwrapDm(event);
          if (dm && dm.senderPk !== myPubkey && dm.ts >= sessionStartS && !seenDmIds.has(dm.id)) {
            seenDmIds.add(dm.id);
            deliver(`✉️ DM from ${engine.nameOf(dm.senderPk)}`, dm.text.slice(0, 90));
          }
          return;
        }
        void engine.handleGiftWrapRecipient(recipient);
        return;
      }
      // Observer frame — failed turns rate a toast. (unchanged)
      try {
        const frame = JSON.parse(client.decryptFrom(event.pubkey, event.content)) as { type?: string; status?: string };
        if (frame.type === "turn" && frame.status === "failed") {
          const agent = event.tags.find((t) => t[0] === "agent")?.[1] ?? engine.nameOf(event.pubkey);
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
  const KIND_REMINDER_V2 = 30176;
  const KIND_CHANNEL_MSG = 47103;
  const armedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const firedIntents = new Set<string>();

  type IntentEvent = { id: string; kind: number; content: string; tags: string[][]; created_at?: number };

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

    // setTimeout's ~24.9-day cap (2^31-1 ms) means armIntent may have
    // clamped a longer delay — recompute what's actually left and re-arm
    // another chunk instead of firing early. For a sealed 40006 that
    // means not disarming the relay scheduler's own correct chunked
    // timer out from under it (shape mirrors the relay scheduler's own
    // fire(), see packages/fez-relay/src/scheduler.ts).
    const at =
      intent.kind === KIND_REMINDER
        ? decodeReminder(intent).at
        : Number(intent.tags.find((t) => t[0] === "send_at")?.[1]);
    const remaining = at * 1000 - Date.now();
    if (remaining > 1000) {
      armedTimers.set(intent.id, setTimeout(() => void fireIntent(intent), Math.min(remaining, 2 ** 31 - 1)));
      return;
    }

    firedIntents.add(intent.id);
    if (intent.kind === KIND_SCHEDULED) {
      const sealed = parseSealed(intent.content);
      if (sealed) {
        // Sealed intent: release the author's own pre-signed event
        // verbatim. Idempotent — if the relay scheduler already released
        // it, the duplicate id is dropped at ingest.
        await relay.publish(sealed as never);
        console.log(`⏲ released sealed scheduled message ${sealed.id.slice(0, 8)}…`);
      } else {
        // Legacy plaintext. The old gate also required a retired "c"
        // tag scheduleMessage never set — legacy intents silently never
        // fired, which means the c-tag bugfix would otherwise deliver
        // every historical one — months late — the first time an
        // upgraded sentinel boots. Sealed intents are NOT subject to
        // this cutoff: the relay scheduler owns their timing, and a
        // late sentinel wake just releases normally (id-dedupe protects
        // it if the relay already did).
        const h = intent.tags.find((t) => t[0] === "h")?.[1];
        const STALE_MS = 24 * 60 * 60 * 1000;
        if (Date.now() - at * 1000 > STALE_MS) {
          console.log(`⏲ legacy intent ${intent.id.slice(0, 8)}… too stale to deliver — tombstoned`);
        } else if (h) {
          await relay.publish(client.signEvent({ kind: KIND_CHANNEL_MSG, tags: [["h", h]], content: intent.content }));
          console.log(`⏲ delivered scheduled message to channel ${h.slice(0, 8)}…`);
        }
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

  // ── v2 reminders (30176): replaceable at (pubkey, kind, d), status in
  // the encrypted body — so the timer is keyed by ADDRESS and every newer
  // write supersedes it: a snooze moves it, done/cancelled clears it.
  // Firing never tombstones a v2 (completing is the USER's act), so
  // staleness is the refire guard on BOTH deliverers — mirror fez-client
  // reminders.ts STALE_AFTER_S: ≤60s late still fires, older stays silent.
  const V2_STALE_MS = 60_000;
  function armReminderV2(event: IntentEvent): void {
    const r = decodeReminderV2(event, (c) => client.decryptFrom(myPubkey, c));
    if (!r) return;
    const key = `v2:${r.address}`;
    const held = armedTimers.get(key);
    if (held !== undefined) {
      clearTimeout(held);
      armedTimers.delete(key);
    }
    if (!r.live || r.at * 1000 < Date.now() - V2_STALE_MS) return;
    // Chunked like fireIntent: setTimeout's ~24.9-day cap would fire a
    // longer delay early, so recompute and re-arm until it's really due.
    const fire = () => {
      const remaining = r.at * 1000 - Date.now();
      if (remaining > 1000) {
        armedTimers.set(key, setTimeout(fire, Math.min(remaining, 2 ** 31 - 1)));
        return;
      }
      armedTimers.delete(key);
      deliver("⏰ reminder", r.note);
      console.log(`⏰ fired reminder: ${r.note.slice(0, 60)}`);
    };
    const delayMs = Math.min(Math.max(0, r.at * 1000 - Date.now()), 2 ** 31 - 1);
    armedTimers.set(key, setTimeout(fire, delayMs));
    console.log(`⏲ armed reminder (fires in ${Math.round(delayMs / 1000)}s)`);
  }

  relay.subscribe(
    [{ kinds: [KIND_SCHEDULED, KIND_REMINDER, KIND_REMINDER_V2], authors: [myPubkey], since: sessionStartS }],
    (event) => (event.kind === KIND_REMINDER_V2 ? armReminderV2(event) : armIntent(event))
  );
  const [intents, tombstones] = await Promise.all([
    relay.query([{ kinds: [KIND_SCHEDULED, KIND_REMINDER, KIND_REMINDER_V2], authors: [myPubkey] }]),
    relay.query([{ kinds: [5], authors: [myPubkey] }]),
  ]);
  const dead = new Set(tombstones.flatMap((t) => t.tags.filter((x) => x[0] === "e").map((x) => x[1])));
  // Oldest first, so if a relay hands back more than one write per v2
  // address the newest lands last and owns the timer. Kind-5 tombstones
  // are a v1 concept — a v2 is "deleted" by a status write, not an id.
  for (const intent of intents.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))) {
    if (intent.kind === KIND_REMINDER_V2) armReminderV2(intent);
    else if (!dead.has(intent.id)) armIntent(intent);
  }

  // The optional headless runtime shares exactly the desktop's extension host.
  backgroundHost = await prepareBackgroundTasks(client, relay, () => relayUrls[0], background);
  await backgroundHost.start();

  console.log(`   watching: DM summons · mention summons · doc-comment summons · notifications · schedules/reminders. Ctrl+C to stop.`);
}

// Only boot when this file IS the program. It is both a daemon entry
// point (`#!/usr/bin/env node`, run directly) and a module other code
// imports pure helpers from — summonMentions and isSafeWork are used by
// three eval suites. A bare `main()` at module scope made every one of
// those imports start a real sentinel, which then failed on the missing
// relay/identity and took the importing process down with process.exit(1).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSentinel().catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
}
