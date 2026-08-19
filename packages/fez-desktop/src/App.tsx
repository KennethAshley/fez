import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { FezClient, setStatePersistence, type Artifact, type Msg, type ObserverEntry, type WireEvent } from "@fez/client";
import { BrowserWire } from "./wire";
import { bindMention, describeMentionProblems, type MentionBindings } from "@fez/client";
import Composer from "./Composer";
import SearchOverlay from "./SearchOverlay";
import AgentsPane from "./AgentsPane";
import ManagePane from "./ManagePane";
import HomeView from "./HomeView";
import PulseView from "./PulseView";
import WorkflowsView from "./WorkflowsView";
import SkillsView from "./SkillsView";
import ProfilePane from "./ProfilePane";
import RemindersPane from "./RemindersPane";
import DocsPane from "./DocsPane";
import WikiView from "./WikiView";
import ChannelInfo from "./ChannelInfo";
import SettingsPane from "./SettingsPane";
import ActivityFeed from "./ActivityFeed";
import { viewerFor } from "./artifact-viewers";
import { loadGuiExtensions } from "./gui-extensions";
import Avatar from "./Avatar";
import HoverCard from "./HoverCard";
import { uploadFile, shareLine } from "./upload";
import { runCommand } from "./commands";
import Onboarding from "./Onboarding";
import FirstRun from "./FirstRun";
import { foldLedger, InlineProposal, proposalIdsIn } from "./BenchProposals";
import { messageDecorators } from "./gui-extensions";
import { EMOJI, searchEmoji } from "./emoji";
import "./App.css";

/**
 * fez-desktop — the GUI over the same headless brain as the TUI (#30).
 * Buzz's visual skeleton (left rail, timeline, right pane), fez's
 * client: every trust rule, thread, presence dot, unread badge, DM, and
 * observer frame below comes from @fez/client — this file only renders.
 */

/**
 * The relay SET. Stored comma-separated under the same key the single
 * relay used, so an existing install keeps working and adding a second
 * relay is editing one string rather than a migration.
 */
function relaySet(): string[] {
  const raw =
    (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_RELAY ??
    localStorage.getItem("fez-relay") ??
    "ws://localhost:7777";
  const urls = raw.split(",").map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : ["ws://localhost:7777"];
}
/** Keychain account — override with VITE_FEZ_ACCOUNT=demo to walk onboarding as a fresh user without touching your real identity. */
const ACCOUNT = (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_ACCOUNT ?? "default";
const KIND_TURN_METRIC = 47030;
const KIND_OBSERVER_CONTROL = 20005;

setStatePersistence({
  exists: () => localStorage.getItem("fez-state") !== null,
  read: () => localStorage.getItem("fez-state") ?? undefined,
  write: (text) => localStorage.setItem("fez-state", text),
});

type Boot =
  | { phase: "loading" }
  | { phase: "onboarding" }
  | { phase: "error"; message: string }
  | { phase: "ready"; client: FezClient; wire: BrowserWire };

type MainView =
  | { kind: "channel"; focus?: string }
  | { kind: "dm"; convoKey: string }
  | { kind: "home" }
  | { kind: "pulse" }
  | { kind: "wiki" }
  | { kind: "workflows" }
  | { kind: "skills" };
type SidePane =
  | { kind: "watch"; agent: string }
  | { kind: "costs" }
  | { kind: "agents" }
  | { kind: "manage" }
  | { kind: "profile"; pk: string }
  | { kind: "reminders" }
  | { kind: "docs"; channelId: string; communityId: string }
  | undefined;

function useForceRender(): () => void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return bump;
}

/** Native notification, permission-lazy; silently a no-op where unavailable. */
async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body: body.replace(/\s+/g, " ").slice(0, 180) });
  } catch {
    /* browser dev server / permission denied */
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dayLabel(tsSeconds: number): string {
  const date = new Date(tsSeconds * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "today";
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return "yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function sameDay(a: number, b: number): boolean {
  return new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
}

/**
 * Boot is a MODULE-LEVEL singleton: React StrictMode double-mounts and
 * Fast-Refresh remounts re-run effects, and the first version of this
 * closed the live wire on every remount — a wedged socket with silent
 * send failures (found the hard way: messages typed into the dev window
 * evaporated). One wire + one client per page lifetime; remounts reuse.
 */
let bootPromise: Promise<{ client: FezClient; wire: BrowserWire }> | undefined;

function bootOnce(): Promise<{ client: FezClient; wire: BrowserWire }> {
  bootPromise ??= (async () => {
    const keyHex = await invoke<string>("get_identity", { account: ACCOUNT });
    const wire = new BrowserWire(relaySet(), keyHex);
    const client = new FezClient(wire);
    await client.start();

    // An invite accepted during onboarding is claimed HERE, with the
    // final identity — you cannot be a member before you are anybody,
    // and claiming it earlier would bind the membership to a key that
    // is about to be replaced.
    const pendingInvite = localStorage.getItem("fez-pending-invite");
    if (pendingInvite) {
      localStorage.removeItem("fez-pending-invite");
      try {
        await client.joinCommunity(pendingInvite);
      } catch { /* the community's events haven't reached this relay yet */ }
    }

    if (client.state.joined.size === 0) {
      for (const community of await client.listCommunities()) {
        await client.joinCommunity(community.id);
      }
      // Default scope: the LIVELIEST channel we're a member of — not map
      // order, which landed users in stale one-person rooms (found live:
      // three mentions shouted into an empty ghost town).
      let best: { communityId: string; channelId: string; members: number } | undefined;
      for (const community of client.state.communities.values()) {
        for (const channel of community.channels.values()) {
          if (!channel.members.has(client.pubkey)) continue;
          if (!best || channel.members.size > best.members) {
            best = { communityId: community.id, channelId: channel.id, members: channel.members.size };
          }
        }
      }
      if (best) client.setScope(best.communityId, best.channelId);
    }
    const scope = client.state.scope;
    if (scope) await client.loadChannelHistory(scope.channelId, scope.communityId);
    void loadGuiExtensions(client); // gui parts of installed packages — non-blocking
    return { client, wire };
  })();
  bootPromise.catch(() => {
    bootPromise = undefined; // a failed boot may retry (e.g. after onboarding)
  });
  return bootPromise;
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [connected, setConnected] = useState(true);
  const [relayHealth, setRelayHealth] = useState<{ url: string; connected: boolean }[]>([]);
  const [bootNonce, setBootNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void bootOnce()
      .then(({ client, wire }) => {
        if (cancelled) return;
        wire.onStatus = setConnected;
        wire.onRelayHealth = setRelayHealth;
        setBoot({ phase: "ready", client, wire });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // No keychain identity = a NEW USER, not an error — onboarding.
        if (/no fez identity/i.test(message)) setBoot({ phase: "onboarding" });
        else setBoot({ phase: "error", message });
      });
    return () => {
      cancelled = true; // never close the singleton wire on remount
    };
  }, [bootNonce]);

  if (boot.phase === "loading") return <div className="boot">connecting…</div>;
  if (boot.phase === "onboarding") {
    return (
      <Onboarding
        onComplete={(relayUrl) => {
          localStorage.setItem("fez-relay", relayUrl);
          setBoot({ phase: "loading" });
          setBootNonce((n) => n + 1); // re-run the boot effect with the new identity
        }}
      />
    );
  }
  if (boot.phase === "error") return <div className="boot error">{boot.message}</div>;
  return <Shell client={boot.client} wire={boot.wire} connected={connected} relayHealth={relayHealth} />;
}

function Shell({
  client,
  wire,
  connected,
  relayHealth,
}: {
  client: FezClient;
  wire: BrowserWire;
  connected: boolean;
  relayHealth: { url: string; connected: boolean }[];
}) {
  const render = useForceRender();
  const [view, setView] = useState<MainView>({ kind: "channel" });
  const [pane, setPane] = useState<SidePane>();
  const [banner, setBanner] = useState<string>();
  useEffect(() => {
    wire.onError = (message) => {
      setBanner(message);
      setTimeout(() => setBanner(undefined), 6000);
    };
  }, [wire]);
  // Channel mutes are a VIEW preference, not protocol state — GUI-local
  // (Buzz's ChannelContextMenu decision): muted channels lose their
  // badge and never notify, events still flow.
  const [muted, setMuted] = useState<Set<string>>(
    () => new Set<string>(JSON.parse(localStorage.getItem("fez-muted") ?? "[]") as string[])
  );
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const toggleMute = (channelId: string) => {
    const next = new Set(muted);
    if (!next.delete(channelId)) next.add(channelId);
    localStorage.setItem("fez-muted", JSON.stringify([...next]));
    setMuted(next);
  };
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; channelId: string; communityId: string }>();
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  // Rolling observer activity per agent — the client emits frames; the
  // GUI keeps the last 200 per agent for the watch pane.
  const activityRef = useRef(new Map<string, ObserverEntry[]>());
  // Live agent drafts (ephemeral 20003): channelId → authorPk → frame.
  // The agent's reply streams here BEFORE the final message exists — the
  // GUI's "live typing", adopted away when the real message lands.
  const draftsRef = useRef(new Map<string, Map<string, { content: string; rootId?: string; ts: number }>>());

  useEffect(() => {
    const events = [
      "message", "messageEdited", "messageDeleted", "metaChanged", "reaction",
      "channelsChanged", "presenceChanged", "unreadsChanged", "typingChanged",
      "dmMessage", "jobsChanged", "notice", "workflowRunsChanged", "artifact",
    ] as const;
    for (const name of events) client.on(name, render as never);
    client.on("draft", ((channelId: string, authorPk: string, content: string, rootId?: string) => {
      let byAuthor = draftsRef.current.get(channelId);
      if (!byAuthor) draftsRef.current.set(channelId, (byAuthor = new Map()));
      byAuthor.set(authorPk, { content, rootId, ts: Date.now() });
      render();
    }) as never);
    client.on("message", ((channelId: string, msg: Msg) => {
      // The final message adopts the draft — stop streaming it.
      draftsRef.current.get(channelId)?.delete(msg.authorPk);
    }) as never);
    client.on("observerFrame", ((agent: string, frame: ObserverEntry) => {
      const list = activityRef.current.get(agent) ?? [];
      list.push(frame);
      if (list.length > 200) list.splice(0, list.length - 200);
      activityRef.current.set(agent, list);
      render();
    }) as never);
    // Native notifications when the window isn't focused: @you in a
    // channel, or any live DM. Backfill/history never notifies.
    client.on("message", ((channelId: string, msg: Msg, meta?: { live?: boolean }) => {
      if (!meta?.live || msg.authorPk === client.pubkey || document.hasFocus()) return;
      if (mutedRef.current.has(channelId)) return;
      const myName = client.displayName(client.pubkey);
      if (myName && new RegExp(`@${escapeRe(myName)}\\b`, "i").test(msg.content)) {
        void notify(`${msg.authorName} mentioned you`, msg.content);
      }
    }) as never);
    client.on("dmMessage", ((dm: { senderPk: string; text: string }, meta?: { live?: boolean }) => {
      if (!meta?.live || dm.senderPk === client.pubkey || document.hasFocus()) return;
      void notify(`${client.displayName(dm.senderPk)} (dm)`, dm.text);
    }) as never);
  }, [client, render]);

  // ⌘K — Buzz's topbar search, as a palette (also /search <words>).
  const [searchOpen, setSearchOpen] = useState<false | { query: string }>(false);
  const [selfMenu, setSelfMenu] = useState(false);
  const [browse, setBrowse] = useState<{ id: string; name: string; joined: boolean }[]>();
  const openBrowse = () => {
    setBrowse([]);
    void client.listCommunities().then((list) => setBrowse(list));
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => (open ? false : { query: "" }));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scope = client.state.scope;
  const unreads = client.unreadCounts();

  /**
   * Badge for "open loops": how many things are BLOCKED on a decision
   * from you. Counted here (cheaply, from state already in memory) so
   * the number is visible without opening the view — an unanswered
   * approval you never noticed is the failure this whole screen exists
   * to prevent. Bench proposals count too (already polled for the agents
   * badge) — a badge that disagrees with the list it opens is worse than
   * no badge.
   */
  const [benchPending, setBenchPending] = useState(0);

  /**
   * Open loops are scanned from the RELAY, not from the in-memory store.
   * loadChannelHistory() only runs for channels you have opened, and the
   * live subscription starts at `now` — so an approval raised in a
   * channel you never clicked is invisible to the client until you go
   * looking. For every other view that is a harmless lazy-load; for the
   * screen whose entire promise is "nothing gets missed" it is the bug
   * that makes the feature a lie. Two bounded queries, every 30s.
   */
  const [loopScan, setLoopScan] = useState<{ msgs: WireEvent[]; answered: Set<string> }>();
  useEffect(() => {
    let live = true;
    const scan = async () => {
      const channelIds: string[] = [];
      for (const communityId of client.state.joined) {
        for (const channel of client.state.communities.get(communityId)?.channels.values() ?? []) {
          channelIds.push(channel.id);
        }
      }
      if (channelIds.length === 0) return;
      try {
        const msgs = (await wire.query([
          { kinds: [47103], "#h": channelIds, since: Math.floor(Date.now() / 1000) - 30 * 86400, limit: 500 },
        ])) as WireEvent[];
        const open = msgs.filter(
          (m) => m.content.startsWith("⛔ approval needed:") || m.content.startsWith("❓ choose:")
        );
        const answered = new Set<string>();
        if (open.length > 0) {
          const reactions = (await wire.query([{ kinds: [7], "#e": open.map((m) => m.id) }])) as WireEvent[];
          for (const reaction of reactions) {
            const target = reaction.tags.find((t) => t[0] === "e")?.[1];
            if (target) answered.add(target);
          }
        }
        if (live) setLoopScan({ msgs: open, answered });
      } catch { /* relay hiccup — keep the last scan */ }
    };
    void scan();
    const timer = setInterval(() => void scan(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, wire]);

  const openLoopCount =
    (loopScan?.msgs.filter((m) => !loopScan.answered.has(m.id)).length ?? 0) +
    [...client.workflowRuns().values()].filter((r) => r.status === "waiting_approval").length +
    benchPending;
  const working = client.workingAgents();

  const openChannel = async (communityId: string, channelId: string, focus?: string) => {
    client.setScope(communityId, channelId);
    setView({ kind: "channel", focus });
    await client.loadChannelHistory(channelId, communityId);
    render();
  };

  const openDm = (convoKey: string) => {
    client.markDmRead(convoKey);
    setView({ kind: "dm", convoKey });
    render();
  };

  /** Slash commands from the composer — routing over surfaces the GUI already has. */
  const runSlash = (text: string) =>
    runCommand(text, {
      client,
      wire,
      channelId: scope?.channelId,
      communityId: scope?.communityId,
      ui: {
        openSearch: (query) => setSearchOpen({ query }),
        watch: (agent) => setPane({ kind: "watch", agent }),
        openDocs: () => {
          if (scope) setPane({ kind: "docs", channelId: scope.channelId, communityId: scope.communityId });
        },
        openAgents: () => setPane({ kind: "agents" }),
        openDm,
        goHome: () => setView({ kind: "home" }),
        goPulse: () => setView({ kind: "pulse" }),
        toggleMute,
      },
    });

  const cancelAgent = async (agentName: string) => {
    const pk = client.pkByName(agentName);
    if (!pk) return;
    await wire.publish({
      kind: KIND_OBSERVER_CONTROL,
      tags: [["p", pk]],
      content: wire.encrypt(pk, JSON.stringify({ cmd: "cancel", ts: Date.now() })),
    });
  };

  const dmConvos = [...client.dmConversations().entries()].sort(
    (a, b) => (b[1].msgs.at(-1)?.ts ?? 0) - (a[1].msgs.at(-1)?.ts ?? 0)
  );

  // Leave uses a two-click confirm (webview dialogs are ugly): first ×
  // arms it, the second click within 4s commits.
  const [armedLeave, setArmedLeave] = useState<string>();
  const leaveCommunity = (communityId: string) => {
    if (armedLeave !== communityId) {
      setArmedLeave(communityId);
      setTimeout(() => setArmedLeave((current) => (current === communityId ? undefined : current)), 4000);
      return;
    }
    setArmedLeave(undefined);
    client.leaveCommunity(communityId);
    // If we just left the room we were in, hop to the liveliest remaining.
    if (!client.state.scope) {
      let best: { communityId: string; channelId: string; members: number } | undefined;
      for (const community of client.state.communities.values()) {
        if (!client.state.joined.has(community.id)) continue;
        for (const channel of community.channels.values()) {
          if (!channel.members.has(client.pubkey)) continue;
          if (!best || channel.members.size > best.members) {
            best = { communityId: community.id, channelId: channel.id, members: channel.members.size };
          }
        }
      }
      if (best) void openChannel(best.communityId, best.channelId);
    }
    render();
  };

  // Bench proposal watch: the tuner/harvester file proposals into the
  // ledger; a NEW pending proposal is a native notification + a badge
  // on the agents nav. Seen-set persists so relaunches stay quiet.
  useEffect(() => {
    const check = async () => {
      try {
        const raw = await invoke<string>("read_bench_proposals");
        const { pending } = foldLedger(raw);
        setBenchPending(pending.length);
        const seen = new Set<string>(JSON.parse(localStorage.getItem("fez-bench-seen") ?? "[]") as string[]);
        const fresh = pending.filter((p) => !seen.has(p.id));
        if (fresh.length > 0) {
          const first = fresh[0];
          void notify(
            "fez — proposal awaiting review",
            first.kind === "description"
              ? `@${first.agent} description change: ${first.rationale}`
              : `new bench case: "${first.q ?? ""}"${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""}`
          );
          localStorage.setItem("fez-bench-seen", JSON.stringify([...seen, ...fresh.map((p) => p.id)].slice(-200)));
        }
      } catch { /* ledger absent — fine */ }
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Resizable sidebars: widths persist; a 5px col-resize strip after the
  // rail and before the pane drags them. Clamped so neither can vanish.
  const [railW, setRailW] = useState(() => Number(localStorage.getItem("fez-rail-w")) || 240);
  const [paneW, setPaneW] = useState(() => Number(localStorage.getItem("fez-pane-w")) || 340);
  const dragRef = useRef<"rail" | "pane" | undefined>(undefined);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragRef.current === "rail") {
        const w = Math.min(420, Math.max(180, e.clientX));
        setRailW(w);
        localStorage.setItem("fez-rail-w", String(w));
      } else if (dragRef.current === "pane") {
        const w = Math.min(640, Math.max(260, window.innerWidth - e.clientX));
        setPaneW(w);
        localStorage.setItem("fez-pane-w", String(w));
      }
    };
    const up = () => {
      dragRef.current = undefined;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);
  const startDrag = (which: "rail" | "pane") => {
    dragRef.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className="shell" style={{ "--rail-w": `${railW}px`, "--pane-w": `${paneW}px` } as React.CSSProperties}>
      {!connected && (
        <div className="conn-bar">
          {relayHealth.length > 1 ? `all ${relayHealth.length} relays unreachable` : "relay disconnected"} — reconnecting…
        </div>
      )}
      {connected && relayHealth.length > 1 && relayHealth.some((r) => !r.connected) && (
        <div className="conn-bar warn">
          {relayHealth.filter((r) => r.connected).length}/{relayHealth.length} relays — down:{" "}
          {relayHealth.filter((r) => !r.connected).map((r) => r.url).join(", ")}
        </div>
      )}
      {banner && <div className="conn-bar error">{banner}</div>}
      <aside className="rail">
        <div className="brand">
          <span className="brand-word">fez</span>{" "}
          {/* A green dot that means "at least one relay" hides the
              difference between four relays and the one you have left. */}
          <span
            className={connected ? (relayHealth.every((r) => r.connected) ? "dot on" : "dot partial") : "dot off"}
            title={
              relayHealth.length === 0
                ? connected ? "relay connected" : "reconnecting…"
                : relayHealth.map((r) => `${r.connected ? "●" : "○"} ${r.url}`).join("\n")
            }
          />
        </div>
        <button className="rail-search" onClick={() => setSearchOpen({ query: "" })}>
          <span className="rail-search-glyph">⌕</span> search everything
          <span className="rail-search-key">⌘K</span>
        </button>
        <div className="rail-scroll">
        <button className={view.kind === "home" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "home" })}>
          ▤ inbox
          {openLoopCount > 0 && <span className="badge">{openLoopCount}</span>}
        </button>
        <button
          className={pane?.kind === "agents" ? "channel active home-link" : "channel home-link"}
          onClick={() => setPane(pane?.kind === "agents" ? undefined : { kind: "agents" })}
        >
          ⚉ agents
          {benchPending > 0 && <span className="badge">{benchPending}</span>}
        </button>
        <button className={view.kind === "pulse" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "pulse" })}>
          ◉ pulse
        </button>
        <button className={view.kind === "wiki" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "wiki" })}>
          ▤ docs
        </button>
        <button className={view.kind === "skills" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "skills" })}>
          ⊞ extensions
        </button>
        <button className={view.kind === "workflows" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "workflows" })}>
          » workflows
        </button>
        <button className="channel home-link" onClick={openBrowse}>
          ⌂ browse communities
        </button>
        {[...client.state.communities.values()]
          .filter((community) => client.state.joined.has(community.id))
          .map((community, _index, joined) => (
            <div key={community.id} className="community">
              <div className="community-name">
                {community.name}
                {joined.filter((other) => other.name === community.name).length > 1 && (
                  <span className="community-id"> ·{community.id.slice(0, 4)}</span>
                )}
                <button
                  className="community-add"
                  title="manage — create channels, invite members, roles"
                  onClick={() => {
                    const first = [...community.channels.values()][0];
                    if (first) {
                      void openChannel(community.id, first.id).then(() => setPane({ kind: "manage" }));
                    }
                  }}
                >
                  +
                </button>
                <button
                  className={armedLeave === community.id ? "leave armed" : "leave"}
                  title={armedLeave === community.id ? "click again to leave" : `leave ${community.name} (local — rejoin anytime)`}
                  onClick={() => leaveCommunity(community.id)}
                >
                  {armedLeave === community.id ? "leave?" : "×"}
                </button>
              </div>
              {[...community.channels.values()].map((channel) => {
                const active = view.kind === "channel" && scope?.channelId === channel.id;
                const unread = unreads.get(channel.id) ?? 0;
                return (
                  <button
                    key={channel.id}
                    className={`channel${active ? " active" : ""}${muted.has(channel.id) ? " muted" : ""}`}
                    title={`${channel.members.size} member${channel.members.size === 1 ? "" : "s"} — right-click for options`}
                    onClick={() => void openChannel(community.id, channel.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtxMenu({ x: e.clientX, y: e.clientY, channelId: channel.id, communityId: community.id });
                    }}
                  >
                    <span className="hash">#</span> {channel.name}
                    {muted.has(channel.id) && <span className="mute-mark" title="muted">✕</span>}
                    {channel.members.size <= 1 && <span className="ghost" title="nobody else is in this channel">∅</span>}
                    {unread > 0 && !active && !muted.has(channel.id) && <span className="badge">{unread}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        <div className="community">
          <div className="community-name">
            dms
            <NewDmButton client={client} onOpen={openDm} />
          </div>
            {dmConvos.slice(0, 10).map(([key, convo]) => {
              const group = key.includes("+");
              const active = view.kind === "dm" && view.convoKey === key;
              return (
                <HoverCard key={key} client={client} pk={key}>
                  <button className={active ? "channel active" : "channel"} onClick={() => openDm(key)}>
                    {!group && <Avatar pk={key} size={16} title={client.dmTitle(key)} />}
                    {group ? <span className="group-mark">&</span> : <span className={client.isOnline(key) ? "dot on" : "dot off"} />} {client.dmTitle(key)}
                    {convo.unread > 0 && !active && <span className="badge">{convo.unread}</span>}
                  </button>
                </HoverCard>
              );
            })}
        </div>
        </div>
        <div className="self-wrap">
          {selfMenu && (
            <>
              <div className="menu-backdrop" onClick={() => setSelfMenu(false)} />
              <div className="self-menu">
                <div className="self-menu-head" title={client.pubkey}>
                  {client.pubkey.slice(0, 16)}…
                </div>
                {(
                  [
                    ["⊙", "profile", () => setPane({ kind: "profile", pk: client.pubkey })],
                    ["⌕", "search", () => setSearchOpen({ query: "" }), "⌘K"],
                    ["@", "agents", () => setPane({ kind: "agents" })],
                    ["$", "costs", () => setPane({ kind: "costs" })],
                    ["◷", "reminders", () => setPane({ kind: "reminders" })],
                  ] as [string, string, () => void, string?][]
                ).map(([glyph, label, action, key]) => (
                  <button
                    key={label}
                    className="self-menu-item"
                    onClick={() => {
                      setSelfMenu(false);
                      action();
                    }}
                  >
                    <span className="self-menu-glyph">{glyph}</span> {label}
                    {key && <span className="self-menu-key">{key}</span>}
                  </button>
                ))}
                <div className="self-menu-rule" />
                <button
                  className="self-menu-item"
                  onClick={() => {
                    setSelfMenu(false);
                    setSettingsOpen(true);
                  }}
                >
                  <span className="self-menu-glyph">⚙</span> settings
                  <span className="self-menu-key">⌘,</span>
                </button>
              </div>
            </>
          )}
          <button className="self-card" title="menu" onClick={() => setSelfMenu((open) => !open)}>
            <Avatar pk={client.pubkey} size={28} title="you" />
            <span className="self-meta">
              <span className="self-name">{client.knownNames().get(client.pubkey) ?? "you"}</span>
              <span className="self-status">{client.statusOf(client.pubkey) ?? (connected ? "online" : "reconnecting…")}</span>
            </span>
            <span className={connected ? "dot on" : "dot off"} />
            <span className="self-chevron">{selfMenu ? "⌄" : "⌃"}</span>
          </button>
        </div>
      </aside>
      <div className="rz" onMouseDown={() => startDrag("rail")} />

      {view.kind === "channel" && scope && (
        <ChannelView
          key={scope.channelId + (view.focus ?? "")}
          focusId={view.focus}
          client={client}
          wire={wire}
          channelId={scope.channelId}
          drafts={draftsRef.current.get(scope.channelId)}
          working={working}
          onWatch={(agent) => setPane({ kind: "watch", agent })}
          onManage={() => setPane(pane?.kind === "manage" ? undefined : { kind: "manage" })}
          onAgents={() => setPane({ kind: "agents" })}
          onNotice={(text) => { setBanner(text); setTimeout(() => setBanner(undefined), 6000); }}
          onProfile={(pk) => setPane({ kind: "profile", pk })}
          onDocs={() =>
            setPane(
              pane?.kind === "docs" && pane.channelId === scope.channelId
                ? undefined
                : { kind: "docs", channelId: scope.channelId, communityId: scope.communityId }
            )
          }
          onCommand={runSlash}
        />
      )}
      {view.kind === "dm" && (
        <DmView
          key={view.convoKey}
          client={client}
          wire={wire}
          convoKey={view.convoKey}
          onProfile={(pk) => setPane({ kind: "profile", pk })}
        />
      )}
      {view.kind === "home" && (
        <HomeView
          client={client}
          wire={wire}
          scan={loopScan}
          onOpenChannel={(communityId, channelId, msgId) => void openChannel(communityId, channelId, msgId)}
          onOpenDm={openDm}
        />
      )}
      {view.kind === "pulse" && (
        <PulseView
          client={client}
          wire={wire}
          activity={activityRef.current}
          working={working}
          onWatch={(agent) => setPane({ kind: "watch", agent })}
        />
      )}
      {view.kind === "wiki" && <WikiView client={client} />}
      {view.kind === "workflows" && <WorkflowsView client={client} />}
      {view.kind === "skills" && <SkillsView client={client} wire={wire} />}
      {view.kind === "channel" && !scope && <div className="boot">no channel — pick one from the rail</div>}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            onClick={() => {
              const newest = client.messages(ctxMenu.channelId).at(-1);
              if (newest) client.markRead(ctxMenu.channelId, newest.ts);
              setCtxMenu(undefined);
            }}
          >
            ✓ mark read
          </button>
          <button
            onClick={() => {
              toggleMute(ctxMenu.channelId);
              setCtxMenu(undefined);
            }}
          >
            {muted.has(ctxMenu.channelId) ? "🔔︎ unmute" : "✕ mute"}
          </button>
        </div>
      )}

      {pane && <div className="rz" onMouseDown={() => startDrag("pane")} />}
      {pane?.kind === "watch" && (
        <WatchPane
          agent={pane.agent}
          entries={activityRef.current.get(pane.agent) ?? []}
          working={working.has(pane.agent)}
          onCancel={() => void cancelAgent(pane.agent)}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "costs" && <CostsPane client={client} wire={wire} onClose={() => setPane(undefined)} />}
      {settingsOpen && (
        <div className="overlay settings-overlay" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <div className="settings-modal">
            <SettingsPane client={client} wire={wire} onClose={() => setSettingsOpen(false)} />
          </div>
        </div>
      )}
      {pane?.kind === "reminders" && (
        <RemindersPane
          client={client}
          wire={wire}
          onJumpToMessage={(msgId) => {
            for (const communityId of client.state.joined) {
              const community = client.state.community(communityId);
              for (const channel of community?.channels.values() ?? []) {
                if (client.messages(channel.id).some((m) => m.id === msgId)) {
                  void openChannel(communityId, channel.id, msgId);
                  return;
                }
              }
            }
          }}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "docs" && (
        <DocsPane
          client={client}
          channelId={pane.channelId}
          communityId={pane.communityId}
          renderMd={(text) => <MdBody text={text} />}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "profile" && (
        <ProfilePane
          client={client}
          pk={pane.pk}
          working={working}
          onDm={openDm}
          onWatch={(agent) => setPane({ kind: "watch", agent })}
          onSettings={() => setSettingsOpen(true)}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "manage" && (
        <ManagePane
          client={client}
          onOpenChannel={(communityId, channelId) => void openChannel(communityId, channelId)}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "agents" && (
        <AgentsPane
          client={client}
          wire={wire}
          activity={activityRef.current}
          working={working}
          onCancel={(agent) => void cancelAgent(agent)}
          onDm={(pk) => openDm(pk)}
          onClose={() => setPane(undefined)}
        />
      )}
      {browse !== undefined && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setBrowse(undefined)}>
          <div className="search-box browse-box">
            <div className="pane-head"><span>communities on this relay</span>
              <button className="pane-close" onClick={() => setBrowse(undefined)}>✕</button>
            </div>
            <div className="search-results">
              {browse.length === 0 && <div className="pane-empty">loading…</div>}
              {browse.map((community) => (
                <div key={community.id} className="browse-row">
                  <span className="browse-name">
                    {community.name} <span className="community-id">·{community.id.slice(0, 6)}</span>
                  </span>
                  {community.joined ? (
                    <span className="role-tag installed-tag">joined</span>
                  ) : (
                    <button
                      className="agent-action"
                      onClick={() =>
                        void client.joinCommunity(community.id).then(() => {
                          render();
                          void client.listCommunities().then(setBrowse);
                        })
                      }
                    >
                      join
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="settings-hint browse-hint">
              Joining shows the community's channels in your sidebar. Reading member-gated channels still requires
              the creator to /invite you; agents can't hear you in channels you're not a member of.
            </div>
          </div>
        </div>
      )}
      {searchOpen && (
        <SearchOverlay
          client={client}
          wire={wire}
          initialQuery={searchOpen.query}
          onJump={(communityId, channelId, msgId) => void openChannel(communityId, channelId, msgId)}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

/** Buzz's NewMessageScreen, minimal: type a name, get the conversation. */
function NewDmButton({ client, onOpen }: { client: FezClient; onOpen: (convoKey: string) => void }) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState("");
  const start = () => {
    const raw = who.trim().replace(/^@/, "");
    const pk = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : client.pkByName(raw);
    if (!pk) return;
    setOpen(false);
    setWho("");
    onOpen(pk);
  };
  if (!open) {
    return (
      <button className="mini new-dm" title="new direct message" onClick={() => setOpen(true)}>+</button>
    );
  }
  return (
    <input
      className="manage-input new-dm-input"
      value={who}
      autoFocus
      spellCheck={false}
      placeholder="@name or pubkey"
      onChange={(e) => setWho(e.target.value)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") start();
        if (e.key === "Escape") setOpen(false);
      }}
    />
  );
}


function ChannelView({
  client,
  wire,
  channelId,
  drafts,
  working,
  onWatch,
  onManage,
  onAgents,
  onProfile,
  onDocs,
  onCommand,
  onNotice,
  focusId,
}: {
  client: FezClient;
  wire: BrowserWire;
  channelId: string;
  focusId?: string;
  drafts?: Map<string, { content: string; rootId?: string; ts: number }>;
  working: ReadonlyMap<string, { activity: string; ts: number }>;
  onWatch: (agent: string) => void;
  onManage: () => void;
  onAgents: () => void;
  onProfile: (pk: string) => void;
  onDocs: () => void;
  onCommand: (text: string) => Promise<string>;
  /** Surfaced to the sender — a mention that reached nobody must not be silent. */
  onNotice: (text: string) => void;
}) {
  // Drafts persist per channel (Buzz's DraftsPanel decision, minimal
  // form): switching channels no longer eats half-typed messages.
  const [draft, setDraftState] = useState(() => localStorage.getItem(`fez-draft-${channelId}`) ?? "");
  const setDraft = (text: string) => {
    setDraftState(text);
    if (text) localStorage.setItem(`fez-draft-${channelId}`, text);
    else localStorage.removeItem(`fez-draft-${channelId}`);
  };

  /**
   * Who each @name in the draft actually means, decided when the sender
   * picked them out of the autocomplete. It rides with the draft — a
   * half-typed message that survives a channel switch must not come
   * back pointing at a different person.
   */
  const bindingsKey = `fez-draft-mentions-${channelId}`;
  const [bindings, setBindingsState] = useState<MentionBindings>(() => {
    try {
      return new Map<string, string>(JSON.parse(localStorage.getItem(bindingsKey) ?? "[]"));
    } catch {
      return new Map();
    }
  });
  const setBindings = (next: MentionBindings) => {
    setBindingsState(next);
    if (next.size) localStorage.setItem(bindingsKey, JSON.stringify([...next]));
    else localStorage.removeItem(bindingsKey);
  };
  const [uploading, setUploading] = useState<string>();
  // A focused thread reply opens inside its thread (the channel view
  // only shows roots); the component remounts per focus so lazy init is enough.
  const [membersOpen, setMembersOpen] = useState(false);
  const [threadRoot, setThreadRoot] = useState<string | undefined>(() => {
    if (!focusId) return undefined;
    return client.messages(channelId).find((m) => m.id === focusId)?.rootId;
  });
  const [editing, setEditing] = useState<{ id: string; original: string } | undefined>();
  const communityId = client.state.scope?.communityId ?? "";
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = client.messages(channelId);
  const shown = threadRoot ? messages.filter((m) => m.id === threadRoot || m.rootId === threadRoot) : messages.filter((m) => !m.parentId);
  // Typed artifacts interleave by time (channel view only — they don't thread).
  type TimelineRow = { ts: number; msg?: Msg; artifact?: Artifact };
  const rows: TimelineRow[] = [
    ...shown.map((m) => ({ ts: m.ts, msg: m })),
    ...(threadRoot ? [] : client.artifacts(channelId).map((a) => ({ ts: a.ts, artifact: a }))),
  ].sort((a, b) => a.ts - b.ts);
  const now = Date.now();
  const liveDrafts = [...(drafts?.entries() ?? [])].filter(([, d]) => now - d.ts < 15_000);
  const draftsForRoot = (rootId: string) => liveDrafts.filter(([, d]) => d.rootId === rootId);
  const workingNow = [...working.entries()].filter(([, w]) => now - w.ts < 30_000);

  // Anchored scroll (Buzz's policy): stick to the bottom only while the
  // reader is AT the bottom; scrolled-up positions survive new messages.
  // A focused jump (search/inbox hit) pins the view on that message.
  const timelineRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  useEffect(() => {
    if (focusId) {
      document.getElementById(`msg-${focusId}`)?.scrollIntoView({ behavior: "auto", block: "center" });
      return;
    }
    if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });
  const trackScroll = () => {
    const el = timelineRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const [cmdNotice, setCmdNotice] = useState<string>();

  // Local persona files — mentions of these SUMMON (sentinel spawns +
  // invites), so an absent-but-summonable agent is info, not a warning.
  const [localPersonas, setLocalPersonas] = useState<string[]>([]);
  useEffect(() => {
    void invoke<string[]>("list_personas").then(setLocalPersonas).catch(() => setLocalPersonas([]));
  }, []);

  /**
   * The ghost-town guard, live (Buzz's NonMemberMentionDialog): every
   * @name in the draft that can't hear you in THIS channel gets called
   * out before you send — summonable, invitable, or unknown.
   */
  const members = client.state.currentChannel()?.channel.members;
  const amCreator = client.state.currentChannel()?.community.creator === client.pubkey;
  const mentionWarnings: { name: string; pk?: string; kind: "summon" | "absent" | "unknown" }[] = [];
  if (members) {
    const seen = new Set<string>();
    for (const match of draft.matchAll(/@([\w-]+)/g)) {
      const name = match[1];
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Picked from the autocomplete and still in the room — settled.
      const bound = bindings.get(key);
      if (bound && members.has(bound)) continue;
      const pk = client.pkByName(name);
      if (pk && members.has(pk)) continue;
      if (pk) mentionWarnings.push({ name, pk, kind: "absent" });
      else if (localPersonas.some((p) => p.toLowerCase() === key)) mentionWarnings.push({ name, kind: "summon" });
      else mentionWarnings.push({ name, kind: "unknown" });
    }
  }

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setBindings(new Map());
    if (!editing && text.startsWith("/")) {
      const feedback = await onCommand(text);
      if (feedback) {
        setCmdNotice(feedback);
        setTimeout(() => setCmdNotice(undefined), 8000);
      }
      return;
    }
    if (editing) {
      const target = editing;
      setEditing(undefined);
      if (text !== target.original) await client.editMessage(channelId, communityId, target.id, text);
      return;
    }
    // Against THIS channel's roster, not every name the client has ever
    // seen — and a mention that reached nobody is said out loud, because
    // it otherwise looks exactly like one that worked.
    const resolution = client.resolveMentionsIn(text, channelId, bindings);
    const problem = describeMentionProblems(resolution);
    await client.sendChannelMessage(text, { threadRootId: threadRoot, mentionPks: resolution.pubkeys });
    if (problem) onNotice(problem);
  };

  /** Discord's up-arrow: empty composer + ↑ edits your latest message in view. */
  const startEditLast = () => {
    const mine = (threadRoot ? messages.filter((m) => m.id === threadRoot || m.rootId === threadRoot) : messages)
      .filter((m) => m.authorPk === client.pubkey && !m.deletedBy)
      .at(-1);
    if (!mine) return;
    setEditing({ id: mine.id, original: mine.content });
    setDraft(mine.content);
    // The old text's @names were bound by whoever sent it, not by this draft.
    setBindings(new Map());
  };

  const beginEdit = (msg: Msg) => {
    setEditing({ id: msg.id, original: msg.content });
    setDraft(msg.content);
    setBindings(new Map());
  };

  /** Drop/paste → Blossom → fez-media's share line into the channel (or thread). */
  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      setUploading(`${file.name} · 0%`);
      try {
        const uploaded = await uploadFile(wire, file, (percent) => setUploading(`${file.name} · ${percent}%`));
        await client.sendChannelMessage(shareLine(uploaded), { threadRootId: threadRoot });
      } catch (err) {
        wire.onError?.(err instanceof Error ? err.message : String(err));
      }
    }
    setUploading(undefined);
  };

  const channelName = client.channelRef(channelId)?.name ?? channelId.slice(0, 8);
  const typing = client.typingWho();

  return (
    <main
      className="main"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        if (files.length) void handleFiles(files);
      }}
    >
      <header className="topbar">
        <span className="hash">#</span> {channelName}
        {threadRoot && (
          <button className="thread-exit" onClick={() => setThreadRoot(undefined)}>← back to channel</button>
        )}
        {!threadRoot && (
          <span className="topbar-tools">
            <button
              className="topbar-tool topbar-members"
              title="members"
              onClick={() => setMembersOpen((open) => !open)}
            >
              ⚉ {client.state.currentChannel()?.channel.members.size ?? 0}
            </button>
            <button className="topbar-tool" title="channel doc" onClick={onDocs}>
              ≡{client.docsByChannel().has(channelId) && <span className="doc-dot" />}
            </button>
            <button className="topbar-tool" title="channel settings — members, invites, moderation" onClick={onManage}>
              ⚙
            </button>
          </span>
        )}
        {membersOpen && !threadRoot && (
          <>
            <div className="menu-backdrop" onClick={() => setMembersOpen(false)} />
            <div className="members-pop">
              <div className="self-menu-head">{client.state.currentChannel()?.channel.members.size ?? 0} members</div>
              {[...(client.state.currentChannel()?.channel.members.keys() ?? [])]
                .map((pk) => ({ pk, name: client.knownNames().get(pk) ?? pk.slice(0, 8) }))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(({ pk, name }) => (
                  <button
                    key={pk}
                    className="self-menu-item"
                    onClick={() => {
                      setMembersOpen(false);
                      onProfile(pk);
                    }}
                  >
                    <Avatar pk={pk} size={16} title={name} />
                    <span className={client.isOnline(pk) ? "dot on" : "dot off"} />
                    {name}
                    {pk === client.pubkey && <span className="self-menu-key">you</span>}
                  </button>
                ))}
            </div>
          </>
        )}
      </header>
      {!threadRoot && (
        <ChannelInfo
          client={client}
          channelId={channelId}
          communityId={communityId}
          channelName={channelName}
          onJump={(msgId) => document.getElementById(`msg-${msgId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        />
      )}
      <div className="timeline" ref={timelineRef} onScroll={trackScroll}>
        {(client.state.currentChannel()?.channel.members.size ?? 0) <= 1 && (
          <div className="empty-room">
            Nobody else is in this channel — agents can't hear you here. Pick a channel without the ∅ mark, or /invite members from the TUI.
          </div>
        )}
        {messages.length === 0 && (client.state.currentChannel()?.channel.members.size ?? 0) > 1 && (
          <FirstRun
            client={client}
            channelName={channelName}
            onOpenAgents={onAgents}
          />
        )}
        {rows.map((row, index) => {
          if (row.artifact) {
            return (
              <div key={row.artifact.id}>
                {(index === 0 || !sameDay(rows[index - 1].ts, row.ts)) && (
                  <div className="day-divider"><span>{dayLabel(row.ts)}</span></div>
                )}
                <ArtifactCard artifact={row.artifact} onAuthor={() => onProfile(row.artifact!.authorPk)} />
              </div>
            );
          }
          const msg = row.msg!;
          return (
          <div key={msg.id} id={`msg-${msg.id}`} className={msg.id === focusId ? "focus-flash" : undefined}>
            {(index === 0 || !sameDay(rows[index - 1].ts, msg.ts)) && (
              <div className="day-divider"><span>{dayLabel(msg.ts)}</span></div>
            )}
            <Bubble
              client={client}
              channelId={channelId}
              communityId={communityId}
              msg={msg}
              wire={wire}
              inThread={!!threadRoot}
              onOpenThread={() => setThreadRoot(msg.rootId ?? msg.id)}
              onEdit={() => beginEdit(msg)}
              onAuthor={() => onProfile(msg.authorPk)}
            />
            {!threadRoot && <RootLiveArea client={client} rootId={msg.id} drafts={draftsForRoot(msg.id)} />}
          </div>
          );
        })}
        {threadRoot &&
          draftsForRoot(threadRoot).map(([pk, d]) => <StreamingBubble key={pk} author={client.displayName(pk)} text={d.content} />)}
        <div ref={bottomRef} />
      </div>
      {typing.length > 0 && <div className="typing">{typing.join(", ")} typing…</div>}
      {workingNow.length > 0 && (
        <div className="activity-strip">
          {workingNow.map(([agent, w]) => (
            <button key={agent} className="activity-chip" onClick={() => onWatch(agent)} title="open live activity">
              <span className="working">⚙</span> {agent}
              <span className="activity-headline shimmer">{w.activity}</span>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <div className="edit-banner">
          editing message · <b>enter</b> saves · <b>esc</b> cancels
        </div>
      )}
      {uploading && <div className="edit-banner">⬆ uploading {uploading}…</div>}
      {cmdNotice && <div className="edit-banner cmd-notice">{cmdNotice}</div>}
      {mentionWarnings.map((warning) => (
        <div key={warning.name} className={warning.kind === "summon" ? "mention-warn summon" : "mention-warn"}>
          {warning.kind === "summon" && <>◌ @{warning.name} isn't here yet — sending will summon it into this channel</>}
          {warning.kind === "unknown" && <>⚠ nobody named @{warning.name} is known — they won't see this</>}
          {warning.kind === "absent" && (
            <>
              ⚠ @{warning.name} isn't in this channel and won't see this
              {amCreator && warning.pk && (
                <button
                  className="mini warn-invite"
                  onClick={() =>
                    void client.invite(warning.pk!, client.agents().has(warning.pk!) ? "bot" : ("member" as never)).catch(() => {})
                  }
                >
                  + invite
                </button>
              )}
            </>
          )}
        </div>
      ))}
      <Composer
        client={client}
        roster={client.mentionCandidates(channelId)}
        onMentionPick={(name, pubkey) => setBindings(bindMention(bindings, name, pubkey))}
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        commandsEnabled
        placeholder={threadRoot ? "reply in thread…" : `message #${channelName}`}
        editing={!!editing}
        onArrowUpEmpty={editing ? undefined : startEditLast}
        onEscape={
          editing
            ? () => {
                setEditing(undefined);
                setDraft("");
              }
            : undefined
        }
        onFiles={(files) => void handleFiles(files)}
      />
    </main>
  );
}

/**
 * The live area under a root message in the channel timeline — where an
 * agent's response becomes VISIBLE without opening the thread: latest
 * reply preview, then per-root typing, then the streaming draft text
 * (fez's 20003 frames carry the actual accumulating reply — one better
 * than a "…is typing" row).
 */
function RootLiveArea({
  client,
  rootId,
  drafts,
}: {
  client: FezClient;
  rootId: string;
  drafts: [string, { content: string; rootId?: string; ts: number }][];
}) {
  // Slack's decision: the channel shows a COUNT, not a preview — the
  // bubble foot's "N replies →" carries it. This area only renders the
  // live parts: streaming drafts and per-root typing.
  const typing = client.typingWho(rootId).filter((name) => name !== "You");
  if (drafts.length === 0 && typing.length === 0) return null;
  return (
    <div className="root-live">
      {drafts.map(([pk, d]) => (
        <StreamingBubble key={pk} author={client.displayName(pk)} text={d.content} compact />
      ))}
      {typing.length > 0 && drafts.length === 0 && (
        <div className="reply-line typing-line">
          <span className="reply-arrow">↳</span> {typing.join(", ")} <span className="shimmer">replying…</span>
        </div>
      )}
    </div>
  );
}

/** An agent's reply streaming in live — dim, cursor, replaced by the real message when it lands. */
function StreamingBubble({ author, text, compact }: { author: string; text: string; compact?: boolean }) {
  return (
    <div className={compact ? "stream compact" : "stream"}>
      <span className="reply-arrow">↳</span> <span className="reply-author">{author}</span>{" "}
      <span className="stream-text">
        {compact ? text.replace(/\s+/g, " ").slice(-160) : text.slice(-800)}
        <span className="cursor">▌</span>
      </span>
    </div>
  );
}

function DmView({
  client,
  wire,
  convoKey,
  onProfile,
}: {
  client: FezClient;
  wire: BrowserWire;
  convoKey: string;
  onProfile: (pk: string) => void;
}) {
  const [draft, setDraftState] = useState(() => localStorage.getItem(`fez-draft-dm-${convoKey}`) ?? "");
  const setDraft = (text: string) => {
    setDraftState(text);
    if (text) localStorage.setItem(`fez-draft-dm-${convoKey}`, text);
    else localStorage.removeItem(`fez-draft-dm-${convoKey}`);
  };
  const [uploading, setUploading] = useState<string>();
  const bottomRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const convo = client.dmConversations().get(convoKey);
  const group = convoKey.includes("+");
  const peers = client.dmPeers(convoKey);

  useEffect(() => {
    client.markDmRead(convoKey);
    if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (group) await client.sendGroupDm(peers, text);
    else await client.sendDm(convoKey, text);
  };

  // NOTE: the blob itself lands on the media server in the clear — only
  // the share line is E2E. Same trade fez-media makes; worth a settings
  // toggle when private Blossom hosts are common.
  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      setUploading(`${file.name} · 0%`);
      try {
        const uploaded = await uploadFile(wire, file, (percent) => setUploading(`${file.name} · ${percent}%`));
        const line = shareLine(uploaded);
        if (group) await client.sendGroupDm(peers, line);
        else await client.sendDm(convoKey, line);
      } catch (err) {
        wire.onError?.(err instanceof Error ? err.message : String(err));
      }
    }
    setUploading(undefined);
  };

  return (
    <main className="main">
      <header className="topbar">
        ✉ {group && <span className="group-mark">& </span>}
        {group ? (
          client.dmTitle(convoKey)
        ) : (
          <button className="author" title="profile" onClick={() => onProfile(convoKey)}>{client.dmTitle(convoKey)}</button>
        )}
        <span className="dm-note">end-to-end encrypted{group ? " · every participant sees every message" : ""}</span>
      </header>
      <div
        className="timeline"
        ref={timelineRef}
        onScroll={() => {
          const el = timelineRef.current;
          if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {(convo?.msgs ?? []).map((msg, index, all) => {
          const mine = msg.senderPk === client.pubkey;
          return (
            <div key={msg.id}>
              {(index === 0 || !sameDay(all[index - 1].ts, msg.ts)) && (
                <div className="day-divider"><span>{dayLabel(msg.ts)}</span></div>
              )}
              <div className={mine ? "bubble mine" : "bubble"}>
              <button className="avatar-btn" title="profile" onClick={() => onProfile(msg.senderPk)}>
                <Avatar pk={msg.senderPk} title={client.displayName(msg.senderPk)} size={30} />
              </button>
              <div className="bubble-head">
                <HoverCard client={client} pk={msg.senderPk}>
                  <button className="author" title="profile" onClick={() => onProfile(msg.senderPk)}>{client.displayName(msg.senderPk)}</button>
                </HoverCard>
                <span className="time">{new Date(msg.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="bubble-body md"><MdBody text={msg.text} /></div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {uploading && <div className="edit-banner">⬆ uploading {uploading}…</div>}
      <Composer
        client={client}
        // A DM's "room" is its participants; delivery is by recipient,
        // so there is nothing to bind — the list just stops offering
        // people who aren't in the conversation.
        roster={peers.map((pk) => ({ pubkey: pk, name: client.displayName(pk), isMember: true }))}
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        placeholder={`message ${client.dmTitle(convoKey)} — encrypted`}
        onFiles={(files) => void handleFiles(files)}
      />
    </main>
  );
}

function WatchPane({
  agent,
  entries,
  working,
  onCancel,
  onClose,
}: {
  agent: string;
  entries: ObserverEntry[];
  working: boolean;
  onCancel: () => void;
  onClose: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });
  return (
    <aside className="pane">
      <header className="pane-head">
        <span>⚙ watching @{agent}</span>
        <div className="pane-actions">
          {working && (
            <button className="cancel" title="abort the in-flight turn (owner-signed)" onClick={onCancel}>⏹ cancel turn</button>
          )}
          <button className="pane-close" onClick={onClose}>✕</button>
        </div>
      </header>
      <div className="pane-body">
        <ActivityFeed entries={entries} emptyNote={`no activity yet — frames stream here while @${agent} works (encrypted to you)`} />
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}

interface MetricRow {
  agent: string;
  turns: number;
  done: number;
  failed: number;
  cancelled: number;
  ms: number;
  recent: number;
}

function CostsPane({ client, wire, onClose }: { client: FezClient; wire: BrowserWire; onClose: () => void }) {
  const [rows, setRows] = useState<MetricRow[] | undefined>();

  useEffect(() => {
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_TURN_METRIC], "#p": [client.pubkey], limit: 500 }]);
      const byAgent = new Map<string, MetricRow>();
      const dayAgo = Date.now() - 24 * 3600_000;
      for (const event of events) {
        try {
          const metric = JSON.parse(wire.decrypt(event.pubkey, event.content)) as {
            agent?: string;
            status?: string;
            durationMs?: number;
            ts?: number;
          };
          const agent = metric.agent ?? "?";
          let row = byAgent.get(agent);
          if (!row) byAgent.set(agent, (row = { agent, turns: 0, done: 0, failed: 0, cancelled: 0, ms: 0, recent: 0 }));
          row.turns++;
          if (metric.status === "done") row.done++;
          else if (metric.status === "failed") row.failed++;
          else if (metric.status === "cancelled") row.cancelled++;
          row.ms += metric.durationMs ?? 0;
          if ((metric.ts ?? 0) >= dayAgo) row.recent++;
        } catch { /* not addressed to us */ }
      }
      setRows([...byAgent.values()].sort((a, b) => b.turns - a.turns));
    })();
  }, [client, wire]);

  return (
    <aside className="pane">
      <header className="pane-head">
        <span>$ turn costs</span>
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      <div className="pane-body">
        {!rows && <div className="pane-empty">decrypting…</div>}
        {rows?.length === 0 && <div className="pane-empty">no turn metrics yet — they accrue as your agents run</div>}
        {rows?.map((row) => (
          <div key={row.agent} className="cost-row">
            <div className="cost-agent">@{row.agent}</div>
            <div className="cost-detail">{row.turns} turns · {row.done} ok · {row.failed} failed · {row.cancelled} cancelled</div>
            <div className="cost-detail">{(row.ms / 60_000).toFixed(1)} min compute · {row.recent} in last 24h</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * A typed artifact in the timeline: header names the type/author, the
 * registered viewer renders the payload; no viewer for the type (or a
 * bare payload) degrades to exactly what the TUI shows — title + link.
 */
function ArtifactCard({ artifact, onAuthor }: { artifact: Artifact; onAuthor: () => void }) {
  const Viewer = viewerFor(artifact.type);
  const body = Viewer ? <Viewer artifact={artifact} /> : null;
  return (
    <div className="artifact-card">
      <div className="artifact-head">
        <span className="role-tag">📦 {artifact.type}</span>
        {artifact.title && <span className="artifact-title">{artifact.title}</span>}
        <button className="author artifact-author" onClick={onAuthor}>{artifact.authorName}</button>
        <span className="time">{new Date(artifact.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      {body ?? (
        <div className="artifact-fallback">
          {artifact.url ? (
            <button className="skill-link" onClick={() => void openUrl(artifact.url!)}>open {artifact.title ?? artifact.type}</button>
          ) : (
            <span className="settings-hint">no viewer for "{artifact.type}" — a GUI extension can register one</span>
          )}
        </div>
      )}
    </div>
  );
}

const QUICK_EMOJI = ["👍", "❤️", "😂", "🚀", "👀"];

/** Slack-style reaction selector: a fixed popover at the cursor/button, never in the message flow. */
function ReactionPicker({ at, onPick, onClose }: { at: { x: number; y: number }; onPick: (emoji: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const results = query.trim() ? searchEmoji(query.trim(), 72) : EMOJI.slice(0, 72);
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="emoji-picker react-picker"
        style={{ left: Math.max(8, Math.min(at.x, window.innerWidth - 280)), top: Math.max(8, Math.min(at.y, window.innerHeight - 300)) }}
      >
      <div className="react-picker-quick">
        {QUICK_EMOJI.map((emoji) => (
          <button key={emoji} onClick={() => onPick(emoji)}>{emoji}</button>
        ))}
      </div>
      <input
        className="emoji-grid-search"
        value={query}
        autoFocus
        placeholder="search all emoji…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && results[0]) onPick(results[0].char);
        }}
      />
      <div className="emoji-grid">
        {results.map((entry) => (
          <button key={entry.name} title={`:${entry.name}:`} onClick={() => onPick(entry.char)}>
            {entry.char}
          </button>
        ))}
      </div>
      </div>
    </>
  );
}

/**
 * Approval request card — an agent called fez_request_approval and is
 * BLOCKED waiting. The buttons publish your ✅/❌ reaction on the ask
 * message: that signed reaction IS the approval (the agent's tool polls
 * for it, and it works identically from the TUI by reacting manually).
 */
function ApprovalCard({
  client,
  msg,
  channelId,
  communityId,
}: {
  client: FezClient;
  msg: Msg;
  channelId: string;
  communityId: string;
}) {
  const reactions = client.reactions(msg.id);
  const decided = reactions
    ? [...reactions.entries()].find(([emoji, who]) => (emoji === "✅" || emoji === "❌") && who.size > 0)?.[0]
    : undefined;
  const action = msg.content.replace(/^⛔ approval needed:\s*/, "").replace(/\n\(react ✅.*$/s, "");
  // NEVER toggle: toggleReaction would REMOVE an existing ✅ (found live —
  // clicking approve on an already-approved ask silently un-approved it).
  // A decision, once any ✅/❌ exists, stands.
  const decideOnce = (emoji: "✅" | "❌") => {
    const current = client.reactions(msg.id);
    const alreadyDecided = current && [...current.entries()].some(([e, who]) => (e === "✅" || e === "❌") && who.size > 0);
    if (alreadyDecided) return;
    void client.toggleReaction(channelId, communityId, msg.id, emoji);
  };
  return (
    <div className={`inline-proposal ${decided === "✅" ? "approved" : decided === "❌" ? "denied" : "pending"}`}>
      <div className="inline-proposal-body">
        <span className="inline-proposal-title">⛔ {msg.authorName} requests approval</span>
        <span className="skill-desc">{action}</span>
        <span className="inline-proposal-why">the agent is blocked until you decide — your reaction is the signed approval</span>
      </div>
      <div className="inline-proposal-actions">
        {decided ? (
          <span className={`role-tag ${decided === "✅" ? "installed-tag" : ""}`}>{decided === "✅" ? "approved" : "denied"}</span>
        ) : (
          <>
            <button className="agent-action approve-btn" onClick={() => decideOnce("✅")}>
              ✓ approve
            </button>
            <button className="mini" onClick={() => decideOnce("❌")}>
              ✗ deny
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const CHOICE_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

/**
 * Choice request card — an agent called fez_ask_owner and is blocked
 * waiting for YOUR pick. Buttons publish your option-number reaction
 * (the signed answer the tool polls for). Recommended options carry
 * the tag; answered cards show what you chose, permanently.
 */
function ChoiceCard({
  client,
  msg,
  channelId,
  communityId,
}: {
  client: FezClient;
  msg: Msg;
  channelId: string;
  communityId: string;
}) {
  const lines = msg.content.split("\n");
  const question = lines[0].replace(/^❓ choose:\s*/, "");
  const options: { label: string; recommended: boolean }[] = [];
  for (const line of lines.slice(1)) {
    const index = CHOICE_EMOJI.findIndex((emoji) => line.startsWith(emoji));
    if (index === options.length) {
      const raw = line.slice(CHOICE_EMOJI[index].length).trim();
      options.push({ label: raw.replace(/ \(recommended\)$/, ""), recommended: / \(recommended\)$/.test(raw) });
    }
  }
  if (options.length < 2) return null;

  const reactions = client.reactions(msg.id);
  let chosen: number | undefined;
  if (reactions) {
    for (const [emoji, who] of reactions.entries()) {
      const index = CHOICE_EMOJI.indexOf(emoji);
      if (index !== -1 && index < options.length && who.size > 0) chosen = index;
    }
  }

  const pick = (index: number) => {
    if (chosen !== undefined) return; // an answer, once given, stands
    void client.toggleReaction(channelId, communityId, msg.id, CHOICE_EMOJI[index]);
  };

  return (
    <div className={`inline-proposal ${chosen !== undefined ? "approved" : "pending"}`}>
      <div className="inline-proposal-body">
        <span className="inline-proposal-title">❓ {msg.authorName} asks: {question}</span>
        <div className="choice-options">
          {options.map((option, index) => (
            <button
              key={index}
              className={`choice-option${option.recommended ? " recommended" : ""}${chosen === index ? " chosen" : ""}`}
              disabled={chosen !== undefined}
              onClick={() => pick(index)}
            >
              {option.label}
              {option.recommended && <span className="choice-rec">recommended</span>}
              {chosen === index && " ✓"}
            </button>
          ))}
        </div>
        <span className="inline-proposal-why">
          {chosen !== undefined ? `answered: "${options[chosen].label}"` : "the agent is blocked until you choose — your reaction is the signed answer"}
        </span>
      </div>
    </div>
  );
}

function Bubble({
  client,
  channelId,
  communityId,
  msg,
  wire,
  inThread,
  onOpenThread,
  onEdit,
  onAuthor,
}: {
  client: FezClient;
  channelId: string;
  communityId: string;
  msg: Msg;
  wire: BrowserWire;
  inThread: boolean;
  onOpenThread: () => void;
  onEdit?: () => void;
  onAuthor?: () => void;
}) {
  const mine = msg.authorPk === client.pubkey;
  const replies = client.threadReplyCount(channelId, msg.id);
  const reactions = client.reactions(msg.id);
  const pinned = client.isPinned(channelId, msg.id);
  const time = new Date(msg.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number }>();
  const [remindOpen, setRemindOpen] = useState(false);
  const [remindSet, setRemindSet] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reported, setReported] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [copied, setCopied] = useState(false);

  /** fez-moderation's /report: 1984, reason NIP-44'd to the community creator. */
  const sendReport = async () => {
    const creator = client.state.communities.get(communityId)?.creator;
    const reason = reportReason.trim();
    if (!creator || !reason) return;
    setReportOpen(false);
    setReportReason("");
    await wire.publish({
      kind: 1984,
      tags: [["c", communityId], ["p", creator]],
      content: wire.encrypt(creator, JSON.stringify({ targetPk: msg.authorPk, reason: `${reason} (msg: ${msg.content.slice(0, 60)})`, ts: Date.now() })),
    });
    setReported(true);
    setTimeout(() => setReported(false), 2500);
  };

  const react = (emoji: string) => {
    setPickerAt(undefined);
    void client.toggleReaction(channelId, communityId, msg.id, emoji);
  };

  /** Buzz's remind-me-later: a preset menu, subject = this message. */
  const remind = (deltaS: number) => {
    setRemindOpen(false);
    const note = `${msg.authorName}: ${msg.content.replace(/\s+/g, " ").slice(0, 80)}`;
    void client.setReminder(Math.floor(Date.now() / 1000) + deltaS, note, msg.id).then(() => {
      setRemindSet(true);
      setTimeout(() => setRemindSet(false), 2500);
    });
  };
  const tomorrow9 = () => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return Math.floor((date.getTime() - Date.now()) / 1000);
  };

  /** Slack's right-click: the full action list as a context menu at the cursor. */
  const menuItem = (label: string, glyph: string, run: () => void, danger = false) => (
    <button
      key={label}
      className={danger ? "self-menu-item danger" : "self-menu-item"}
      onClick={() => {
        setMenu(undefined);
        run();
      }}
    >
      <span className="menu-glyph">{glyph}</span>
      {label}
    </button>
  );

  return (
    <div
      className={mine ? "bubble mine" : "bubble"}
      onContextMenu={(e) => {
        if (msg.deletedBy || window.getSelection()?.toString()) return; // text selection keeps the OS menu
        e.preventDefault();
        setMenu({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 320) });
      }}
    >
      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(undefined)} onContextMenu={(e) => { e.preventDefault(); setMenu(undefined); }} />
          <div className="msg-menu" style={{ left: menu.x, top: menu.y }}>
            {menuItem("add reaction…", "☺", () => setPickerAt(menu))}
            {!inThread && menuItem("reply in thread", "↩", onOpenThread)}
            {menuItem("remind me about this", "◷", () => setRemindOpen(true))}
            {menuItem(copied ? "copied ✓" : "copy text", "⧉", () => {
              void navigator.clipboard.writeText(msg.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })}
            {!pinned && menuItem("pin to channel", "⚑", () => void client.pinMessage(channelId, communityId, msg.id))}
            {mine && onEdit && menuItem("edit message", "✎", onEdit)}
            {!mine && menuItem("report to community creator…", "⚑!", () => setReportOpen(true))}
            {client.canDeleteMessage(communityId, msg) && (
              <button
                className="self-menu-item danger"
                onClick={() => {
                  if (!armedDelete) {
                    setArmedDelete(true);
                    setTimeout(() => setArmedDelete(false), 3000);
                    return; // menu stays open — second click confirms
                  }
                  setArmedDelete(false);
                  setMenu(undefined);
                  void client.deleteMessage(channelId, communityId, msg.id);
                }}
              >
                <span className="menu-glyph">⌫</span>
                {armedDelete ? "click again to delete" : "delete message…"}
              </button>
            )}
          </div>
        </>
      )}
      <button className="avatar-btn" title="profile" onClick={onAuthor}>
        <Avatar pk={msg.authorPk} title={msg.authorName} size={30} />
      </button>
      <div className="bubble-head">
        <HoverCard client={client} pk={msg.authorPk}>
          <button className="author" title="profile" onClick={onAuthor}>{msg.authorName}</button>
        </HoverCard>
        <span className="time">{time}</span>
        {msg.edited && <span className="time">edited</span>}
        {pinned && <span className="pin-mark" title="pinned">⚑</span>}
        {!msg.deletedBy && (
          <div className="actions">
            <button
              title="react"
              onClick={(e) => {
                if (pickerAt) return setPickerAt(undefined);
                const rect = e.currentTarget.getBoundingClientRect();
                setPickerAt({ x: rect.right - 264, y: rect.bottom + 6 });
              }}
            >
              ☺
            </button>
            <button title="remind me about this" onClick={() => setRemindOpen(!remindOpen)}>{remindSet ? "✓" : "◷"}</button>
            {!mine && (
              <button title="report to the community creator (encrypted)" onClick={() => setReportOpen(!reportOpen)}>
                {reported ? "✓" : "⚑!"}
              </button>
            )}
            {!inThread && <button title="reply in thread" onClick={onOpenThread}>↩</button>}
            {mine && onEdit && <button title="edit (↑ also edits your last)" onClick={onEdit}>✎</button>}
            <button
              title={pinned ? "pinned" : "pin"}
              onClick={() => {
                if (!pinned) void client.pinMessage(channelId, communityId, msg.id);
              }}
            >
              ⚑
            </button>
            {client.canDeleteMessage(communityId, msg) && (
              <button
                className={armedDelete ? "danger armed-delete" : "danger"}
                title={armedDelete ? "click again — leaves a visible tombstone" : "delete"}
                onClick={() => {
                  if (!armedDelete) {
                    setArmedDelete(true);
                    setTimeout(() => setArmedDelete(false), 3000);
                    return;
                  }
                  setArmedDelete(false);
                  void client.deleteMessage(channelId, communityId, msg.id);
                }}
              >
                {armedDelete ? "⌫?" : "⌫"}
              </button>
            )}
          </div>
        )}
      </div>
      {reportOpen && (
        <div className="emoji-picker report-form">
          <input
            className="manage-input"
            value={reportReason}
            autoFocus
            placeholder="why? only the community creator can read this"
            onChange={(e) => setReportReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void sendReport();
              if (e.key === "Escape") setReportOpen(false);
            }}
          />
          <button onClick={() => void sendReport()}>report</button>
        </div>
      )}
      {remindOpen && (
        <div className="emoji-picker remind-picker">
          <button onClick={() => remind(20 * 60)}>20m</button>
          <button onClick={() => remind(60 * 60)}>1h</button>
          <button onClick={() => remind(3 * 60 * 60)}>3h</button>
          <button onClick={() => remind(tomorrow9())}>tmrw 9a</button>
        </div>
      )}
      {pickerAt && <ReactionPicker at={pickerAt} onPick={react} onClose={() => setPickerAt(undefined)} />}
      {msg.deletedBy ? (
        <div className="tombstone">⌫ removed by {msg.deletedBy === "moderator" ? "a moderator" : "its author"}</div>
      ) : (
        <div className="bubble-body md">
          <MdBody text={msg.content} />
        </div>
      )}
      {proposalIdsIn(msg.content).map((id) => (
        <InlineProposal key={id} id={id} />
      ))}
      {msg.content.startsWith("⛔ approval needed:") && (
        <ApprovalCard client={client} msg={msg} channelId={channelId} communityId={communityId} />
      )}
      {msg.content.startsWith("❓ choose:") && (
        <ChoiceCard client={client} msg={msg} channelId={channelId} communityId={communityId} />
      )}
      {messageDecorators()
        .filter((d) => d.match(msg.content))
        .map((d, i) => (
          <div key={`deco-${i}`} className="msg-decoration">
            {d.render({ content: msg.content, msgId: msg.id, channelId, communityId, authorName: msg.authorName })}
          </div>
        ))}
      <div className="bubble-foot">
        {reactions &&
          [...reactions.entries()].map(([emoji, who]) => (
            <button
              key={emoji}
              className={client.myReactionTo(msg.id, emoji) ? "pill mine-pill" : "pill"}
              title={[...who].join(", ")}
              onClick={() => react(emoji)}
            >
              {emoji} {who.size}
            </button>
          ))}
        {!inThread && replies > 0 && (
          <button className="thread-link" onClick={onOpenThread}>
            {replies} repl{replies === 1 ? "y" : "ies"} →
          </button>
        )}
      </div>
    </div>
  );
}

function renderMentions(text: string) {
  return text.split(/(@[\w-]+)/g).map((part, index) =>
    part.startsWith("@") ? (
      <span key={index} className="mention">
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

const IMAGE_URL = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/gi;
/** 📎 name.ext (…) url — fez-media's share line; render the blob when the NAME is an image. */
const MEDIA_LINE = /📎\s+(\S+\.(?:png|jpe?g|gif|webp|svg))\s+\([^)]*\)\s+(https?:\/\/\S+)/i;

/** Markdown body: gfm, @mention accents, external links via the OS browser, inline images. */
function MdBody({ text }: { text: string }) {
  const images = [...new Set([...(text.match(IMAGE_URL) ?? []), ...(text.match(MEDIA_LINE) ? [text.match(MEDIA_LINE)![2]] : [])])];
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void openUrl(href);
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (src ? <img className="md-img" src={src} alt={alt ?? ""} /> : null),
          code: ({ className, children }) => {
            // ```diff fences render like the transcript's diff blocks —
            // agents posting patches into channels get real diffs.
            if (/language-diff/.test(className ?? "")) {
              return (
                <span className="md-diff">
                  {String(children ?? "").replace(/\n$/, "").split("\n").map((line, index) => (
                    <span
                      key={index}
                      className={line.startsWith("+") ? "diff-line add" : line.startsWith("-") ? "diff-line del" : "diff-line"}
                    >
                      {line || " "}
                    </span>
                  ))}
                </span>
              );
            }
            return <code className={className}>{children}</code>;
          },
          p: ({ children }) => <p>{accentMentions(children)}</p>,
          li: ({ children }) => <li>{accentMentions(children)}</li>,
        }}
      >
        {text}
      </ReactMarkdown>
      {images.map((src) => (
        <img key={src} className="md-img" src={src} alt="" />
      ))}
    </>
  );
}

/** Wrap @names in accent spans inside rendered markdown children. */
function accentMentions(children: React.ReactNode): React.ReactNode {
  const walk = (node: React.ReactNode): React.ReactNode => {
    if (typeof node === "string") return renderMentions(node);
    if (Array.isArray(node)) return node.map((child, i) => <span key={i}>{walk(child)}</span>);
    return node;
  };
  return walk(children);
}
