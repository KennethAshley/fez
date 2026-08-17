import net from "node:net";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FezExtensionAPI } from "./api-types.js";

/**
 * fez-herdr — register fez personas as herdr-managed tabs and pin a
 * clickable herdr section in the sidebar. herdr (the user's terminal
 * workspace manager for AI agents) exposes a newline-delimited JSON
 * socket API at ~/.config/herdr/herdr.sock; this extension speaks it
 * directly over node:net — no CLI dependency, nothing to bundle.
 *
 * /herdr register <persona> <channel> [respondTo]  — create a labeled
 *   herdr tab, type the channel-agent run command into its shell
 *   (pane.send_text), and track it: herdr now supervises the agent,
 *   which survives fez restarts and is attachable in the herdr session.
 * /herdr list | focus <persona> | status
 *
 * The sidebar section lists registered tabs with live status glyphs;
 * each entry is an OSC-8 hyperlink (fez-herdr://focus/<tabId>) — a
 * mouse click jumps the herdr session to that agent's terminal, via
 * the registerUrlHandler primitive.
 */

const SOCKET = path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const REGISTRY = path.join(os.homedir(), ".fez", "herdr-tabs.json");

interface HerdrResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** One request per connection — simple and reconnect-free for a low-rate control surface. */
function herdrCall(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buf = "";
    const id = Math.random().toString(36).slice(2);
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      sock.end();
      try {
        const msg: HerdrResponse = JSON.parse(buf.slice(0, newline));
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result ?? {});
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    setTimeout(() => {
      sock.destroy();
      reject(new Error("herdr socket timeout"));
    }, 5000).unref?.();
  });
}

interface RegisteredTab {
  persona: string;
  /** Channel specs (names or ids) this agent's process serves — grows as summons pull it into new channels. */
  channels: string[];
  tabId: string;
  paneId: string;
}

function loadRegistry(): RegisteredTab[] {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, "utf-8")) as (RegisteredTab & { channel?: string })[];
    // Migrate pre-multi-channel entries ({channel: "x"} -> {channels: ["x"]}).
    return raw.map((t) => ({ ...t, channels: t.channels ?? (t.channel ? [t.channel] : []) }));
  } catch {
    return [];
  }
}

function saveRegistry(tabs: RegisteredTab[]): void {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(tabs, null, 2), "utf-8");
}

const OSC8 = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

export default function herdr(api: FezExtensionAPI): void {
  let registered = loadRegistry();
  const panel = api.ui.createSidePanel({ title: "agents", icon: "🤖" });
  let liveTabIds = new Set<string>();

  async function refreshPanel(): Promise<void> {
    try {
      const result = await herdrCall("tab.list", {});
      const tabs = (result.tabs as { tab_id: string }[]) ?? [];
      liveTabIds = new Set(tabs.map((t) => t.tab_id));
    } catch {
      liveTabIds = new Set(); // herdr down — everything shows ○
    }
    const lines: string[] = [];
    if (registered.length === 0) {
      lines.push(dim("@mention a persona to summon it"));
    }
    // Agent-centric: the entry IS the agent (click → its terminal), not a
    // channel binding — mentions can pull an agent into any channel, so a
    // single-channel label would lie. One channel shows by name; more
    // collapse to a count.
    for (const tab of registered) {
      const alive = liveTabIds.has(tab.tabId);
      const glyph = alive ? "\x1b[32m●\x1b[39m" : dim("○");
      // Channel names read well; raw channel-id specs (auto-spawn stores
      // ids) are noise at sidebar width — count them instead.
      const named = tab.channels.filter((c) => !/^[0-9a-f]{8}-/.test(c));
      const where =
        named.length > 0
          ? dim(`#${named[0].slice(0, 12)}${tab.channels.length > 1 ? ` +${tab.channels.length - 1}` : ""}`)
          : tab.channels.length > 1
            ? dim(`·${tab.channels.length}ch`)
            : "";
      lines.push(`${glyph} ${OSC8(`fez-herdr://focus/${tab.tabId}`, `@${tab.persona}`)} ${where}`);
    }
    panel.setText(lines.join("\n"));
  }

  api.registerUrlHandler("fez-herdr://focus/", (url) => {
    const tabId = url.slice("fez-herdr://focus/".length);
    void herdrCall("tab.focus", { tab_id: tabId }).catch(() => {});
  });

  function agentCommand(persona: string, channels: string[], respondTo: string): string {
    const relay = process.env.FEZ_RELAY ?? "wss://relay.damus.io";
    // FEZ_AGENT_OWNER = the registering user: enables the encrypted
    // observer stream (/watch <persona>) for free on registered agents.
    // No channels = DM-only mode (a DM summons wakes an agent into no
    // channel at all — DMs are channel-free).
    return `FEZ_AGENT_OWNER=${api.nostr!.pubkey} FEZ_RELAY=${relay} fez agent ${persona} -c ${channels.length > 0 ? channels.join(",") : "none"} --respond-to ${respondTo}\n`;
  }

  /** Create the herdr tab and type the run command — shared by /herdr register and auto-spawn. */
  async function registerAgent(persona: string, channels: string[], respondTo: string): Promise<RegisteredTab> {
    // Re-registering replaces the agent's tab — close the old one (its
    // process is dead; that's why we're here) instead of orphaning a
    // shell pane per summon.
    const prior = registered.find((t) => t.persona === persona);
    if (prior && liveTabIds.has(prior.tabId)) {
      await herdrCall("tab.close", { tab_id: prior.tabId }).catch(() => {});
    }
    const created = await herdrCall("tab.create", {
      label: `fez:${persona}`,
      cwd: process.cwd(),
      focus: false,
    });
    const tab = created.tab as { tab_id: string };
    const pane = created.root_pane as { pane_id: string };
    await herdrCall("pane.send_text", { pane_id: pane.pane_id, text: agentCommand(persona, channels, respondTo) });
    const entry: RegisteredTab = { persona, channels, tabId: tab.tab_id, paneId: pane.pane_id };
    registered = registered.filter((t) => t.persona !== persona);
    registered.push(entry);
    saveRegistry(registered);
    await refreshPanel();
    return entry;
  }

  /**
   * A summon into a channel the agent doesn't serve: restart its EXISTING
   * pane with the union of channels — one process per persona, not one
   * per channel.
   */
  async function expandAgentChannels(entry: RegisteredTab, channel: string): Promise<void> {
    entry.channels.push(channel);
    saveRegistry(registered);
    await herdrCall("pane.send_keys", { pane_id: entry.paneId, keys: ["ctrl+c"] });
    await new Promise((r) => setTimeout(r, 800));
    await herdrCall("pane.send_text", { pane_id: entry.paneId, text: agentCommand(entry.persona, entry.channels, "owner") });
    await refreshPanel();
  }

  // ── Auto-spawn: @mentioning a persona that isn't running summons it.
  // Watch the user's OWN channel messages for @names that match a persona
  // file (~/.fez/personas/<name>.md) with no live herdr tab; spawn it into
  // the mentioned channel, then invite its pubkey (as the community
  // creator) the moment its 47000 metadata announcement appears. The
  // freshly spawned agent backfills the summoning mention itself
  // (channel-agent's name-mention + backfill logic). ────────────────────
  const KIND_AGENT_METADATA = 47000;
  const KIND_AGENT_ATTESTATION = 47006;
  const KIND_CHANNEL_MESSAGE = 47103;
  const KIND_MEMBERSHIP = 47102;
  const KIND_GIFT_WRAP = 1059; // NIP-59 wrap carrying a NIP-17 DM — see fez src/dm.ts
  const DM_FUZZ_WINDOW_S = 2 * 86_400; // wrap timestamps fuzz up to 2 days BACK
  const spawning = new Set<string>();
  // pubkey -> persona name, from 47000 announcements. Any DM-able agent
  // has one (the sender needed its pubkey, and pubkeys travel via 47000).
  const agentPkToName = new Map<string, string>();
  const pendingInvites = new Map<string, { channelId: string; communityId: string }>(); // persona -> where to invite
  const attested = new Set<string>(); // agent pubkeys attested this session
  // Pubkeys allowed to summon local personas via @mention (self is implicit):
  // hydrated from the user's own 47006 attestations, grown on new attests.
  const attestedSiblings = new Set<string>();

  /**
   * Owner attestation (47006): the registering user signs "this pubkey is
   * my agent", making the agent a verifiable SIBLING — other agents with
   * respondTo=owner admit it, so the user's fleet chains freely while
   * strangers stay locked out (Buzz's NIP-OA posture).
   */
  function attestAgent(agentPubkey: string): void {
    if (attested.has(agentPubkey)) return;
    attested.add(agentPubkey);
    attestedSiblings.add(agentPubkey); // freshly attested agents may summon too
    void api
      .nostr!.publish({ kind: KIND_AGENT_ATTESTATION, tags: [["p", agentPubkey]], content: "" })
      .catch(() => attested.delete(agentPubkey));
  }

  /**
   * A persona herdr can actually spawn as a channel-agent. Orchestrator
   * personas (fez.md) declare `harness: router` — they're standing
   * services the user runs themselves; auto-spawning one here would
   * launch a channel-agent that exits on the unknown harness and leave
   * a dead tab.
   */
  // The sentinel (fez sentinel, ~/.fez/sentinel.pid) owns react-while-
  // unattended duties when it's running — this extension's watchers
  // defer to it instead of double-summoning. TUI-only setups (no
  // sentinel) keep the in-window behavior.
  let sentinelCache = { verdict: false, at: 0 };
  function sentinelAlive(): boolean {
    if (Date.now() - sentinelCache.at < 5000) return sentinelCache.verdict;
    let verdict = false;
    try {
      const pid = Number(fs.readFileSync(path.join(os.homedir(), ".fez", "sentinel.pid"), "utf-8").trim());
      if (pid > 0) {
        process.kill(pid, 0);
        verdict = true;
      }
    } catch { /* no pidfile or dead pid */ }
    sentinelCache = { verdict, at: Date.now() };
    return verdict;
  }

  /** Is a fez-acp process for this persona alive right now (herdr-managed or not)? */
  function agentProcessAlive(persona: string): boolean {
    try {
      execSync(`pgrep -f "(fez|cli\\.js) agent ${persona}"`, { stdio: "pipe" });
      return true;
    } catch {
      return false; // pgrep exits non-zero on no match
    }
  }

  function personaExists(name: string): boolean {
    try {
      const raw = fs.readFileSync(path.join(os.homedir(), ".fez", "personas", `${name}.md`), "utf-8");
      const harness = raw.match(/^harness:\s*(.+)$/m)?.[1]?.trim();
      return harness !== undefined && harness !== "router";
    } catch {
      return false;
    }
  }

  async function inviteToChannel(agentPubkey: string, channelId: string, communityId: string): Promise<void> {
    const memberships = await api.nostr!.query([{ kinds: [KIND_MEMBERSHIP], "#d": [channelId] }]);
    const latest = memberships.sort((a, b) => a.created_at - b.created_at).at(-1);
    const ptags = latest?.tags.filter((t) => t[0] === "p") ?? [];
    if (ptags.some((t) => t[1] === agentPubkey)) return; // already a member
    ptags.push(["p", agentPubkey, "bot"]);
    await api.nostr!.publish({
      kind: KIND_MEMBERSHIP,
      tags: [["d", channelId], ["c", communityId], ...ptags],
      content: "",
    });
  }

  if (api.nostr) {
    const nostr = api.nostr;
    // Summoning authority: the user's own messages, plus messages from
    // pubkeys the user has ATTESTED (47006) — their orchestrator and
    // fleet. Without this, a fez-routed "@researcher <task>" reaches only
    // agents that happen to be running; with it, routing wakes the fleet.
    // Strangers' mentions never spawn anything on this machine.
    void nostr
      .query([{ kinds: [KIND_AGENT_ATTESTATION], authors: [nostr.pubkey] }])
      .then((events) => {
        for (const event of events) {
          const pk = event.tags.find((t) => t[0] === "p")?.[1];
          if (pk) attestedSiblings.add(pk);
        }
      })
      .catch(() => {});
    // Hydrate the pubkey->persona roster from stored announcements — the
    // DM watcher below needs it to recognize which wraps target OUR fleet.
    void nostr
      .query([{ kinds: [KIND_AGENT_METADATA], limit: 200 }])
      .then((events) => {
        for (const event of events) {
          try {
            const name = JSON.parse(event.content).name?.toLowerCase();
            if (name) agentPkToName.set(event.pubkey, name);
          } catch { /* ignore */ }
        }
      })
      .catch(() => {});
    // ── Live tab status: fleet state mirrored into herdr tab labels —
    // `fez:researcher 👀` (accepted), `fez:researcher ⚙ WebSearch`
    // (turn running, current tool), bare label when idle. Derived from
    // the same wire signals the jobs board reads: status reactions (7),
    // their deletions (5), and owner-encrypted observer frames (20004).
    // Renames only fire when the label actually changes.
    const KIND_REACTION = 7;
    const KIND_DELETION = 5;
    const KIND_OBSERVER = 20004;
    const tabStatus = new Map<string, { suffix: string; sentLabel?: string }>();
    function setStatusSuffix(persona: string, suffix: string): void {
      const entry = registered.find((t) => t.persona === persona);
      if (!entry) return;
      const st = tabStatus.get(persona) ?? { suffix: "" };
      st.suffix = suffix;
      const label = `fez:${persona}${suffix}`;
      if (st.sentLabel !== label) {
        st.sentLabel = label;
        void herdrCall("tab.rename", { tab_id: entry.tabId, label }).catch(() => {});
      }
      tabStatus.set(persona, st);
    }
    nostr.subscribe(
      [
        { kinds: [KIND_REACTION, KIND_DELETION], since: Math.floor(Date.now() / 1000) },
        { kinds: [KIND_OBSERVER], "#p": [nostr.pubkey] },
      ],
      (event) => {
        const persona = agentPkToName.get(event.pubkey);
        if (!persona) return;
        if (event.kind === KIND_REACTION) {
          if (event.content === "👀") setStatusSuffix(persona, " 👀");
          else if (event.content === "💬") setStatusSuffix(persona, " ⚙");
        } else if (event.kind === KIND_DELETION) {
          setStatusSuffix(persona, "");
        } else {
          try {
            const frame = JSON.parse(nostr.decrypt(event.pubkey, event.content)) as { type?: string; title?: string; status?: string };
            if (frame.type === "tool" && frame.title) setStatusSuffix(persona, ` ⚙ ${String(frame.title).slice(0, 24)}`);
            else if (frame.type === "turn" && frame.status === "started") setStatusSuffix(persona, " ⚙");
            else if (frame.type === "turn") setStatusSuffix(persona, ""); // done | failed | steered
          } catch { /* frame not for us / garbage — ignorable */ }
        }
      }
    );
    // ── DM summons: a gift wrap addressed to a local persona's pubkey
    // wakes it, same contract as a channel @mention. Sender, content,
    // and depth are invisible here — that's the point of wraps — so the
    // spawn is speculative: the agent itself gates the DM (owner ∪
    // attested siblings) and idleExit reaps anything a stranger woke; a
    // stranger's wrap can cost a process spawn, never a turn. Live
    // wraps carry timestamps fuzzed up to 2 days back, so the watch
    // must window back that far; the replayed history that causes is
    // dropped via a short warmup — a stale DM wouldn't be answered
    // anyway (agents only act on DMs fresher than their backfill
    // window), so summoning for one would wake an agent into silence.
    let dmWatchLive = false;
    setTimeout(() => { dmWatchLive = true; }, 5000).unref?.();
    nostr.subscribe(
      [{ kinds: [KIND_GIFT_WRAP], since: Math.floor(Date.now() / 1000) - DM_FUZZ_WINDOW_S }],
      (event) => {
        if (!dmWatchLive || sentinelAlive()) return; // sentinel owns DM summons while it runs
        const recipient = event.tags.find((t) => t[0] === "p")?.[1];
        if (!recipient || recipient === nostr.pubkey) return; // our own inbox is the communities extension's business
        const persona = agentPkToName.get(recipient);
        if (!persona || spawning.has(persona) || !personaExists(persona)) return;
        // Liveness = a real agent PROCESS, not a live herdr tab — a tab
        // whose agent died (or an agent running outside herdr entirely)
        // must not fool the summons either way.
        if (agentProcessAlive(persona)) return;
        const existing = registered.find((t) => t.persona === persona);
        spawning.add(persona);
        api.ui.notify("herdr · " + `✉️ DM for **@${persona}** — summoning it…`);
        // Keep any previously served channels; a never-registered persona
        // wakes DM-only (no channel to invite it into — DMs don't have one).
        registerAgent(persona, existing?.channels ?? [], "owner")
          .then(() => spawning.delete(persona))
          .catch((err) => {
            spawning.delete(persona);
            api.ui.notify("herdr · " + `⚠️ couldn't summon @${persona}: ${err instanceof Error ? err.message : err}`);
          });
      }
    );
    // Mentions in channel messages → summon mentioned-but-absent personas.
    nostr.subscribe(
      [{ kinds: [KIND_CHANNEL_MESSAGE], since: Math.floor(Date.now() / 1000) }],
      (event) => {
        if (sentinelAlive()) return; // the sentinel owns summons while it runs
        if (event.pubkey !== nostr.pubkey && !attestedSiblings.has(event.pubkey)) return;
        // Chain-capped events don't summon — same loop guard agents use.
        if (Number(event.tags.find((t) => t[0] === "depth")?.[1] ?? 0) >= 5) return;
        const channelId = event.tags.find((t) => t[0] === "h")?.[1];
        const communityId = event.tags.find((t) => t[0] === "c")?.[1];
        if (!channelId || !communityId) return;
        for (const match of event.content.matchAll(/@([\w-]+)/g)) {
          const persona = match[1].toLowerCase();
          if (spawning.has(persona) || !personaExists(persona)) continue;
          const existing = registered.find((t) => t.persona === persona);
          if (existing && liveTabIds.has(existing.tabId)) {
            // Running, but summoned into a channel it doesn't serve:
            // restart its pane with the union — one process per persona.
            if (!existing.channels.includes(channelId)) {
              spawning.add(persona);
              pendingInvites.set(persona, { channelId, communityId });
              api.ui.notify("herdr · " + `pulling **@${persona}** into this channel…`);
              expandAgentChannels(existing, channelId)
                .catch((err) => {
                  spawning.delete(persona);
                  api.ui.notify("herdr · " + `⚠️ couldn't expand @${persona}: ${err instanceof Error ? err.message : err}`);
                });
            }
            continue;
          }
          spawning.add(persona);
          pendingInvites.set(persona, { channelId, communityId });
          api.ui.notify("herdr · " + `summoning **@${persona}** — spawning it in a herdr tab…`);
          // respondTo=owner (Buzz's default posture): the summoner and
          // attested sibling agents can trigger it; strangers can't.
          registerAgent(persona, [channelId], "owner")
            .catch((err) => {
              spawning.delete(persona);
              api.ui.notify("herdr · " + `⚠️ couldn't spawn @${persona}: ${err instanceof Error ? err.message : err}`);
            });
        }
      }
    );
    // Agent metadata announcements → complete pending invites.
    nostr.subscribe(
      [{ kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) }],
      (event) => {
        let name: string | undefined;
        try {
          name = JSON.parse(event.content).name?.toLowerCase();
        } catch {
          return;
        }
        if (!name) return;
        agentPkToName.set(event.pubkey, name);
        // Any of our registered agents announcing itself gets an owner
        // attestation — makes it a verifiable sibling to the rest of the
        // fleet, regardless of how it was started.
        if (registered.some((t) => t.persona === name)) attestAgent(event.pubkey);
        if (!pendingInvites.has(name)) return;
        const target = pendingInvites.get(name)!;
        pendingInvites.delete(name);
        spawning.delete(name);
        inviteToChannel(event.pubkey, target.channelId, target.communityId)
          .then(() => api.ui.notify("herdr · " + `**@${name}** is up and invited — it'll answer your mention momentarily.`))
          .catch(() => api.ui.notify("herdr · " + `⚠️ @${name} spawned but the invite failed — /invite ${event.pubkey} bot`));
      }
    );
  }

  api.registerCommand("herdr", async (args, ctx) => {
    const [sub, ...rest] = args.trim().split(/\s+/);

    if (sub === "status") {
      try {
        const pong = await herdrCall("ping", {});
        ctx.reply(`herdr ${pong.version} — protocol ${pong.protocol}, ${registered.length} fez agent(s) registered.`);
      } catch (err) {
        ctx.reply(`herdr unreachable: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (sub === "register") {
      const [persona, channel, respondTo = "anyone"] = rest;
      if (!persona || !channel) return ctx.reply("Usage: /herdr register <persona> <channel> [respondTo]");
      try {
        const entry = await registerAgent(persona, [channel], respondTo);
        ctx.reply(`Registered **@${persona}** with herdr — tab \`${entry.tabId}\` serving #${channel}. Click it in the sidebar to jump to its terminal.`);
      } catch (err) {
        ctx.reply(`herdr registration failed: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (sub === "focus") {
      const persona = rest[0];
      const tab = registered.find((t) => t.persona === persona);
      if (!tab) return ctx.reply(`No registered agent "@${persona}" — /herdr list`);
      await herdrCall("tab.focus", { tab_id: tab.tabId }).catch((err) => ctx.reply(`focus failed: ${err.message}`));
      return;
    }

    if (sub === "list") {
      if (registered.length === 0) return ctx.reply("No fez agents registered with herdr.");
      ctx.reply(
        registered
          .map((t) => `• @${t.persona} → ${t.channels.length > 0 ? t.channels.map((c) => "#" + c).join(", ") : "dm-only"} — tab \`${t.tabId}\` ${liveTabIds.has(t.tabId) ? "(running)" : "(gone)"}`)
          .join("\n")
      );
      return;
    }

    ctx.reply("Usage: /herdr status | register <persona> <channel> [respondTo] | focus <persona> | list");
  });

  void refreshPanel();
  setInterval(() => void refreshPanel(), 15000).unref?.();
}
