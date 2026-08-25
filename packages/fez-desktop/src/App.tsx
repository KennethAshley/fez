import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { openUrl } from "@tauri-apps/plugin-opener";
import { notifyEvent, installNotificationClick } from "./notify";
import { FezClient, setStatePersistence, type Artifact, type Msg, type ObserverEntry, type WireEvent } from "@fezchat/client";
import { BrowserWire } from "./wire";
import { relaySet } from "./relay";
import { bindMention, describeMentionProblems, splitMentions, type MentionBindings } from "@fezchat/client";
import Composer from "./Composer";
import SearchOverlay from "./SearchOverlay";
import AgentsPane from "./AgentsPane";
import ManagePane from "./ManagePane";
import HomeView from "./HomeView";
import PulseView from "./PulseView";
import SkillsView from "./SkillsView";
import { ExtensionPanel } from "./SkillsView";
import ProfilePane from "./ProfilePane";
import RemindersPane from "./RemindersPane";
import DocsPane from "./DocsPane";
import WikiView from "./WikiView";
import ChannelInfo from "./ChannelInfo";
import SettingsPane from "./SettingsPane";
import ActivityFeed from "./ActivityFeed";
import { viewerFor } from "./artifact-viewers";
import { configureLiveBridge, configureLiveConsent } from "./live-artifact";
import { keepTool, unkeepTool, keptTools, isKept, toolArtifact, type KeptTool } from "./tools";
import { exportTool } from "./export-tool";
import { toast } from "./toast";
import {loadGuiExtensions, startAppearanceWatch, threadViewFor, setWatchOpener, setThreadOpener } from "./gui-extensions";
import { matchAction, nextUnreadChannel } from "./keymap";
import { useConfig } from "./config-store";
import { Toaster } from "./Toaster";
import { InstallOffer, installOffers, stripInstallMarkers, stripArtifactMarkers } from "./InstallOffer";
import MemoryView from "./MemoryView";
import Avatar from "./Avatar";
import { AnimatedSprite } from "./pixel-sprite";
import { SPRITES } from "./sprites";
import HoverCard from "./HoverCard";
import { uploadFile, shareLine } from "./upload";
import { runCommand } from "./commands";
import { startUpdateCheck } from "./updater";
import Onboarding from "./Onboarding";
import FirstRun from "./FirstRun";
import { foldLedger, InlineProposal, proposalIdsIn } from "./BenchProposals";
import { messageDecorators, settingsPanelForSource, extensionSettingsPanels } from "./gui-extensions";
import { EMOJI, searchEmoji } from "./emoji";
import "./App.css";

/**
 * fez-desktop — the GUI over the same headless brain as the TUI (#30).
 * Buzz's visual skeleton (left rail, timeline, right pane), fez's
 * client: every trust rule, thread, presence dot, unread badge, DM, and
 * observer frame below comes from @fezchat/client — this file only renders.
 */

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
  | { kind: "tools" }
  | { kind: "extensions" }
  | { kind: "skills" };
type SidePane =
  | { kind: "watch"; agent: string }
  | { kind: "costs" }
  | { kind: "agents" }
  | { kind: "memory" }
  | { kind: "manage" }
  | { kind: "profile"; pk: string }
  | { kind: "reminders" }
  | { kind: "docs"; channelId: string }
  | { kind: "tool"; artifact: Artifact }
  | undefined;

function useForceRender(): () => void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return bump;
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
    // An invite is a relay URL now — the workspace IS the relay, so
    // "joining" is opening it. Nothing to claim against a community id.
    const pendingRelay = localStorage.getItem("fez-pending-invite");
    if (pendingRelay) {
      localStorage.removeItem("fez-pending-invite");
      try {
        await client.openWorkspace(pendingRelay);
      } catch { /* unreachable relay — the rail still remembers it */ }
    }
    // A relay provisioned with --owner arrives CLAIMED but empty — the
    // in-app claim flow (where the owner names the first channel) never
    // runs for it, so the owner lands in a workspace with no rooms and
    // no hint that making one is their move. Desktop-level on purpose:
    // the CLI and tests keep the claim flow's choice of first channel;
    // this is the app's own promise that a fresh workspace has somewhere
    // to talk.
    if (client.state.isOwner(client.pubkey) && client.state.workspace.channels.size === 0) {
      // FIXED id: a cold relay answering the boot query empty made
      // "channels.size === 0" true for an established workspace, and a
      // random-UUID create then minted a second permanent #general
      // (review finding F6). With one well-known id, racing creates
      // converge — latest event for the d-tag wins, duplicates cannot
      // exist by construction.
      await client.ensureChannel({ name: "general", id: "bootstrap-general" }).catch(() => {});
    }
    // Local-workspace owners get the scripted @fez greeting (idempotent —
    // relay-side markers) and a best-effort runner start. Non-blocking:
    // a slow relay must not hold boot.
    void import("./welcome")
      .then(async ({ ensureWelcome }) => {
        await invoke("ensure_agent_runner").catch(() => {});
        await ensureWelcome(client);
      })
      .catch(() => {});
    const scope = client.state.scope;
    if (scope) await client.loadChannelHistory(scope.channelId);
    // Paint before anything renders, and keep following the OS: a
    // one-shot read at boot would leave the app dark after the Mac
    // flips at sunset.
    startAppearanceWatch();
    configureLiveBridge(client); // let "live" artifacts read the relay (read-only)
    void loadGuiExtensions(client); // gui parts of installed packages — non-blocking
    return { client, wire };
  })();
  bootPromise.catch(() => {
    bootPromise = undefined; // a failed boot may retry (e.g. after onboarding)
  });
  return bootPromise;
}

/**
 * Cold-boot splash — Buzz's decision, worn by fez: the animation gets a
 * MINIMUM time on screen (a real boot resolves faster than first paint,
 * and an unheld splash is unmounted before it is ever seen), and once
 * the app is mounted it runs as an overlay ABOVE it, so time-to-
 * interactive pays nothing; only the reveal waits. Instead of one bee,
 * the roster idles in a row — each familiar on its own two frames,
 * staggered so the line reads as a crowd, not a metronome.
 */
const SPLASH_ROSTER = ["scout", "loom", "fez", "vault", "chip"] as const;
const SPLASH_MIN_VISIBLE_MS = 1100;
const SPLASH_FADE_MS = 220;
let splashShownAt = Date.now();

function BootSplash({ loading }: { loading: boolean }) {
  const [phase, setPhase] = useState<"holding" | "fading" | "done">("holding");
  useEffect(() => {
    if (loading) return;
    const hold = Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAt));
    const fade = setTimeout(() => setPhase("fading"), hold);
    const done = setTimeout(() => setPhase("done"), hold + SPLASH_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [loading]);
  if (phase === "done") return null;
  return (
    <div className={phase === "fading" ? "boot-splash fading" : "boot-splash"} role="status">
      <div className="boot-splash-mark">
        fez<span className="boot-splash-tri">▴</span>
      </div>
      <div className="boot-splash-roster">
        {SPLASH_ROSTER.map((id, i) => (
          <span key={id} className="boot-sprite" style={{ "--flap-delay": `${i * 0.14}s` } as React.CSSProperties}>
            <AnimatedSprite sprite={SPRITES[id]} scale={4} />
          </span>
        ))}
      </div>
      <div className="boot-splash-caption">connecting to the relay…</div>
    </div>
  );
}

/**
 * A failed boot is a door, not a wall. The old screen was the raw error
 * string with no way forward — reachable on FIRST LAUNCH by denying the
 * macOS keychain prompt, which told a brand-new user to go run a CLI they
 * don't have. Every boot failure is retryable (a denied prompt re-asks,
 * a dead relay may come back), so the button is unconditional; the
 * keychain hint appears only when the message implicates the keychain.
 */
function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const keychain = /keychain/i.test(message);
  return (
    <div className="boot error">
      <div>
        <p>{message}</p>
        {keychain && (
          <p className="boot-error-hint">
            fez keeps your identity in the macOS keychain. If a permission dialog appeared, choose
            “Always Allow” and try again.
          </p>
        )}
        <button className="agent-action" onClick={onRetry}>try again</button>
      </div>
    </div>
  );
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [connected, setConnected] = useState(true);
  const [relayHealth, setRelayHealth] = useState<{ url: string; connected: boolean }[]>([]);
  const [bootNonce, setBootNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    splashShownAt = Date.now(); // a re-boot (post-onboarding) re-arms the splash hold
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

  if (boot.phase === "loading") return <BootSplash loading />;
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
  if (boot.phase === "error") {
    return (
      <BootError
        message={boot.message}
        onRetry={() => {
          setBoot({ phase: "loading" });
          setBootNonce((n) => n + 1); // bootOnce un-caches a failed boot, so this re-runs it
        }}
      />
    );
  }
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
  // Extensions' window into the watch pane (gui-extensions.openWatch):
  // parked here because the pane is component state and the registry is
  // module state — the seam pattern every other extension surface uses.
  useEffect(() => {
    setWatchOpener((agent) => setPane({ kind: "watch", agent }));
    return () => setWatchOpener(undefined);
  }, []);
  // One update check per app run, once the shell is actually up — a user
  // mid-onboarding shouldn't meet an update toast before a channel.
  useEffect(() => startUpdateCheck(), []);
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
  // Hiding is the local, this-machine cousin of archiving: a muted channel
  // still shows, a hidden one drops out of YOUR sidebar without touching
  // the relay. Archiving (owner-signed) removes it for everyone; hiding
  // removes it for you. Both are reversible.
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set<string>(JSON.parse(localStorage.getItem("fez-hidden") ?? "[]") as string[])
  );
  const toggleHide = (channelId: string) => {
    const next = new Set(hidden);
    if (!next.delete(channelId)) next.add(channelId);
    localStorage.setItem("fez-hidden", JSON.stringify([...next]));
    setHidden(next);
  };
  const [showStowed, setShowStowed] = useState(false);
  // A live tool's proposed write, awaiting the human's yes/no — the wallet
  // prompt. The tool never signs; this dialog is the only path to publish.
  const [toolConsent, setToolConsent] = useState<{ desc: string; resolve: (ok: boolean) => void }>();
  useEffect(() => {
    configureLiveConsent((desc: string) => new Promise<boolean>((resolve) => setToolConsent({ desc, resolve })));
  }, []);
  // Agents that exist as persona files on THIS machine — the sentinel can
  // spawn them on a mention even before they've announced (kind 47000) or
  // joined the roster. So @-mentioning one for the first time is NOT a
  // mention that reached nobody, and must not raise the red warning.
  const [localAgents, setLocalAgents] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = () =>
      void invoke<string[]>("list_personas")
        .then((names) => setLocalAgents(new Set(names.map((n) => n.toLowerCase()))))
        .catch(() => {});
    load();
    window.addEventListener("fez-extensions-changed", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("fez-extensions-changed", load);
      window.removeEventListener("focus", load);
    };
  }, []);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; channelId: string }>();
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
      "dmMessage", "jobsChanged", "artifact",
    ] as const;
    for (const name of events) client.on(name, render as never);
    // Notices carry the relay's own words — "claim this workspace", "ask
    // the owner for an invite, your key is …" — the only first-run
    // explanations the stack produces. They used to be wired to the
    // force-render above, which drops its arguments: shown to nobody.
    // Sticky (ms=0) because they are one-time instructions, and deduped
    // by the toast store so reconnects don't stack repeats.
    client.on("notice", ((text: string) => toast.info(text, 0)) as never);
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
      // A turn that ended in failure is the one agent event worth a ping —
      // silence that looks like slowness is the failure mode this catches.
      if (frame.type === "turn" && frame.status === "failed") {
        notifyEvent({
          key: `agent:${agent}`,
          title: `@${agent} hit an error`,
          body: frame.text ?? frame.title ?? "a turn failed",
          label: "agents",
          target: { kind: "agent", name: agent },
        });
      }
      render();
    }) as never);
    // A freshly-built live tool opens itself in the pane — you watch it
    // appear and stream, no click. Each refinement republishes a new
    // artifact, so this also auto-SWAPS the pane to the latest version:
    // "add a count" and you see it rebuild in place. Guarded so it never
    // pops on history load (recency) or hijacks a pane you're using
    // (only claims an empty pane or one already showing a tool), and only
    // for the channel you're actually looking at.
    client.on("artifact", ((channelId: string, artifact: Artifact) => {
      if (artifact.type !== "live") return;
      if (artifact.ts < Math.floor(Date.now() / 1000) - 90) return;
      if (client.state.scope?.channelId !== channelId) return;
      setPane((cur) => (cur === undefined || cur.kind === "tool" ? { kind: "tool", artifact } : cur));
    }) as never);
    // Native notifications when the window isn't focused: @you in a
    // channel, or any live DM. Backfill/history never notifies.
    client.on("message", ((channelId: string, msg: Msg, meta?: { live?: boolean }) => {
      if (!meta?.live || msg.authorPk === client.pubkey || document.hasFocus()) return;
      if (mutedRef.current.has(channelId)) return;
      const myName = client.displayName(client.pubkey);
      if (myName && new RegExp(`@${escapeRe(myName)}\\b`, "i").test(msg.content)) {
        const chName = client.state.workspace.channels.get(channelId)?.name;
        notifyEvent({
          key: `ch:${channelId}`,
          title: `${msg.authorName} mentioned you`,
          body: msg.content,
          label: chName ? `#${chName}` : "a channel",
          target: { kind: "channel", id: channelId },
        });
      }
    }) as never);
    client.on("dmMessage", ((dm: { senderPk: string; text: string }, meta?: { live?: boolean }) => {
      if (!meta?.live || dm.senderPk === client.pubkey || document.hasFocus()) return;
      notifyEvent({
        key: `dm:${dm.senderPk}`,
        title: `${client.displayName(dm.senderPk)} (dm)`,
        body: dm.text,
        label: "DMs",
        target: { kind: "dm", convoKey: dm.senderPk },
      });
    }) as never);
  }, [client, render]);

  // ⌘K — Buzz's topbar search, as a palette (also /search <words>).
  const [searchOpen, setSearchOpen] = useState<false | { query: string }>(false);
  const [selfMenu, setSelfMenu] = useState(false);
  const [browse, setBrowse] = useState<false | { filter: string }>(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ── Keymap: bindings live in ~/.fez/keymap.json (defaults in keymap.ts),
  // edited by hand or by the Keyboard settings panel. One global listener
  // dispatches to the matched action; see keyActionRef, kept current below.
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  // Keymap comes from the one config store — the Keyboard panel's write fires
  // fez-keymap-changed, the store re-reads, and this re-renders with it.
  const { keymap } = useConfig();
  const keyActionRef = useRef<(e: KeyboardEvent) => void>(() => {});
  // Install/uninstall/update re-scan the gui-extension registries and fire
  // this — re-render so a new panel/view appears (or a removed one vanishes)
  // without a relaunch.
  useEffect(() => {
    const onExtChange = () => render();
    window.addEventListener("fez-extensions-changed", onExtChange);
    return () => window.removeEventListener("fez-extensions-changed", onExtChange);
  }, [render]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyActionRef.current(e);
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
      const channelIds = [...client.state.workspace.channels.keys()];
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
    benchPending;
  const working = client.workingAgents();

  const openChannel = async (channelId: string, focus?: string) => {
    // Refuse an id that names no channel rather than opening a room
    // that cannot exist. The inbox used to hand this the MESSAGE id, and
    // because nothing checked, the header rendered the first 8 hex
    // characters as a channel name and showed an empty room — a wrong
    // destination that looked like a real, if unfamiliar, one. Agents
    // publish into channels this client may not have joined, so the
    // check is against known channels, and the miss is logged rather
    // than thrown: a caller passing something unopenable is a bug in
    // the caller, and it should be visible where it happens.
    if (!client.state.workspace.channels.has(channelId)) {
      console.warn(`openChannel: "${channelId}" is not a channel in this workspace — ignoring`);
      return;
    }
    client.setScope(channelId);
    setView({ kind: "channel", focus });
    await client.loadChannelHistory(channelId);
    render();
  };

  // Point the global key handler at the latest closures every render, so a
  // shortcut always acts on current unreads/scope without re-subscribing.
  keyActionRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    // Let plain keys type; only mod/alt-carrying chords reach global actions mid-edit.
    if (typing && !e.metaKey && !e.ctrlKey && !e.altKey) return;
    const action = matchAction(e, keymap, isMac);
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case "search":
        setSearchOpen((open) => (open ? false : { query: "" }));
        break;
      case "settings":
        setSettingsOpen((open) => !open);
        break;
      case "go-home":
        setView({ kind: "home" });
        break;
      case "next-unread":
      case "prev-unread": {
        const order = [...client.state.workspace.channels.keys()];
        const dest = nextUnreadChannel(order, unreads, scope?.channelId, action === "next-unread" ? 1 : -1);
        if (dest) void openChannel(dest);
        break;
      }
    }
  };

  const openDm = (convoKey: string) => {
    client.markDmRead(convoKey);
    setView({ kind: "dm", convoKey });
    render();
  };

  // Clicking a native notification focuses the app and jumps to its source.
  useEffect(() => {
    installNotificationClick((t) => {
      setPane(undefined);
      if (t.kind === "channel") void openChannel(t.id);
      else if (t.kind === "dm") openDm(t.convoKey);
      else if (t.kind === "agent") setPane({ kind: "agents" });
      else if (t.kind === "proposals") setView({ kind: "pulse" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Slash commands from the composer — routing over surfaces the GUI already has. */
  const runSlash = (text: string) =>
    runCommand(text, {
      client,
      wire,
      channelId: scope?.channelId,
      ui: {
        openSearch: (query) => setSearchOpen({ query }),
        watch: (agent) => setPane({ kind: "watch", agent }),
        openDocs: () => {
          if (scope) setPane({ kind: "docs", channelId: scope.channelId });
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
          notifyEvent({
            key: "proposals",
            title: "fez — proposal awaiting review",
            body:
              first.kind === "description"
                ? `@${first.agent} description change: ${first.rationale}`
                : `new bench case: "${first.q ?? ""}"${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""}`,
            label: "proposals",
            target: { kind: "proposals" },
          });
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
  /**
   * One channel row, wherever it is listed.
   *
   * Extracted because the rail now renders channels in more than one
   * place — the rooms people opened, and a group per bridge — and two
   * copies of a row is how one of them quietly loses unread badges.
   */
  const channelRow = (channel: { id: string; name: string }) => {
    const active = view.kind === "channel" && scope?.channelId === channel.id;
    const unread = unreads.get(channel.id) ?? 0;
    const members = client.state.workspace.members.size;
    return (
      <button
        key={channel.id}
        className={`channel${active ? " active" : ""}${muted.has(channel.id) ? " muted" : ""}`}
        title={`${members} member${members === 1 ? "" : "s"} in this workspace — right-click for options`}
        onClick={() => void openChannel(channel.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, channelId: channel.id });
        }}
      >
        <span className="hash">#</span> {channel.name}
        {muted.has(channel.id) && <span className="mute-mark" title="muted">✕</span>}
        {unread > 0 && !active && !muted.has(channel.id) && <span className="badge">{unread}</span>}
      </button>
    );
  };

  // Channels a person opened, and channels something opened on their
  // behalf. `source` is set by whatever created the channel; absent for
  // everything anybody made by hand, which is most of them.
  const ownChannels: { id: string; name: string }[] = [];
  const bridged = new Map<string, { id: string; name: string }[]>();
  // A bridge's group exists because the extension is INSTALLED, not
  // because it has already opened a channel. Otherwise a freshly
  // installed bridge shows nothing at all, and the only way to set it
  // up is to already know it lives in settings — the extension would be
  // invisible until after the thing you needed it for.
  //
  // The flip side: once the extension is UNINSTALLED, no panel claims
  // its source, so its channels are just channels now. They fall back
  // into the plain list rather than sitting under a heading named after
  // an app you removed — uninstalling the forge never deletes your
  // repos, but it shouldn't keep branding them either.
  const claimedSources = new Set<string>();
  for (const panel of extensionSettingsPanels()) {
    if (panel.source) {
      claimedSources.add(panel.source);
      bridged.set(panel.source, []);
    }
  }
  // Stowed = out of the main list: archived (owner-signed, gone for
  // everyone) or hidden (this machine only). Kept aside so they can be
  // restored, never silently dropped.
  const stowed: { id: string; name: string; archived: boolean }[] = [];
  for (const channel of client.state.workspace.channels.values()) {
    if (channel.archived || hidden.has(channel.id)) {
      stowed.push({ id: channel.id, name: channel.name, archived: !!channel.archived });
      continue;
    }
    if (channel.source && claimedSources.has(channel.source)) {
      const group = bridged.get(channel.source) ?? [];
      group.push(channel);
      bridged.set(channel.source, group);
    } else {
      ownChannels.push(channel);
    }
  }

  // Which extension's settings modal is open, by panel name.
  const [extSettings, setExtSettings] = useState<string | undefined>(undefined);

  const startDrag = (which: "rail" | "pane") => {
    dragRef.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className="shell" style={{ "--rail-w": `${railW}px`, "--pane-w": `${paneW}px` } as React.CSSProperties}>
      <BootSplash loading={false} />
      <Toaster />
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
        {/* The workspace IS the header. The wordmark told you which
            app you were in — which you know — while the thing you
            actually need, WHERE you are, sat below it. The relay-health
            dot comes along: it was never about the brand.

            Search left the sidebar for the top right, where a global
            action belongs, next to the other per-view tools. */}
        <div className="workspace-title" title={client.state.workspace.relay}>
          <span
            className={connected ? (relayHealth.every((r) => r.connected) ? "dot on" : "dot partial") : "dot off"}
            title={
              relayHealth.length === 0
                ? connected ? "relay connected" : "reconnecting…"
                : relayHealth.map((r) => `${r.connected ? "●" : "○"} ${r.url}`).join("\n")
            }
          />
          <span className="workspace-name">{client.state.workspace.name}</span>
          {!client.state.workspace.owner && <span className="workspace-unclaimed">unclaimed</span>}
        </div>
        <div className="rail-scroll">
        <button className={view.kind === "home" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "home" })}>
          ▤ inbox
          {openLoopCount > 0 && <span className="badge">{openLoopCount}</span>}
        </button>
        <button className={view.kind === "wiki" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "wiki" })}>
          ≡ docs
        </button>
        <button className={view.kind === "tools" ? "channel active home-link" : "channel home-link"} onClick={() => setView({ kind: "tools" })}>
          ▣ tools
        </button>
        <div className="community">
          <div className="community-name">
            channels
            {/* Group actions sit with the group, not in the nav list —
                browsing channels is a thing you do TO this list. */}
            <button
              className="community-add"
              title="browse channels"
              onClick={() => setBrowse({ filter: "" })}
            >
              ☰
            </button>
            {/* Everyone gets manage — it holds "join a workspace" and
                "claim/create", the only doors a fresh non-owner has; the
                owner-only levers inside are gated by the pane itself. */}
            <button
              className="community-add"
              title="manage — channels, members, join or create a workspace"
              onClick={() => setPane({ kind: "manage" })}
            >
              +
            </button>
          </div>
          {ownChannels.map(channelRow)}
          {client.state.workspace.channels.size === 0 && (
            <div className="community-id" style={{ padding: "4px 10px" }}>
              {client.state.workspace.owner ? "no channels yet" : "unclaimed — claim it to start"}
            </div>
          )}
          {stowed.length > 0 && (
            <div style={{ marginTop: 2 }}>
              <button
                onClick={() => setShowStowed((v) => !v)}
                style={{ background: "none", border: "none", color: "inherit", opacity: 0.55, font: "inherit", fontSize: "0.82em", cursor: "pointer", padding: "3px 10px", width: "100%", textAlign: "left" }}
              >
                {showStowed ? "▾" : "▸"} {stowed.length} hidden
              </button>
              {showStowed &&
                stowed.map((c) => (
                  <div
                    key={c.id}
                    title={c.archived ? "archived for everyone" : "hidden on this machine"}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px 2px 18px", opacity: 0.6, fontSize: "0.86em" }}
                  >
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span className="hash">#</span> {c.name}
                    </span>
                    <span style={{ fontSize: "0.78em", opacity: 0.7 }}>{c.archived ? "archived" : "hidden"}</span>
                    <button
                      title={c.archived ? "unarchive — bring it back for everyone" : "unhide"}
                      onClick={() =>
                        c.archived
                          ? void client.archiveChannel(c.id, false).catch(() => {})
                          : toggleHide(c.id)
                      }
                      style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", opacity: 0.8, padding: 0 }}
                    >
                      ↩
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        {/* A bridge opens a channel per thing it mirrors. Left in the
            main list, twelve repos read as twelve rooms you are
            neglecting; under their own heading they read as one
            integration. The heading comes from the channel event itself
            (`source`), so fez needs to know nothing about GitHub to
            group GitHub. */}
        {[...bridged.entries()].map(([source, channels]) => {
          // Settings live where the thing they configure is. A bridge's
          // group offers its own panel, and the rail does not know what
          // any particular bridge is — it asks which panel claims this
          // source and shows a button only if one answers.
          const panel = settingsPanelForSource(source);
          return (
            <div className="community" key={source}>
              <div className="community-name">
                {source}
                {panel && (
                  <button
                    className="community-add"
                    title={`${source} settings — choose repositories and how they behave`}
                    onClick={() => setExtSettings(panel.name)}
                  >
                    ⚙
                  </button>
                )}
              </div>
              {channels.map(channelRow)}
              {channels.length === 0 && (
                <button className="channel bridge-empty" onClick={() => panel && setExtSettings(panel.name)}>
                  set it up →
                </button>
              )}
            </div>
          );
        })}
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
        {/* Ambient, not a destination: what is running right now is a
            thing you glance at, never a thing you clear. Empty when the
            fleet is idle, so it costs nothing when there is nothing. */}
        {working.size > 0 && (
          <div className="rail-live" title="agents working now">
            {[...working.entries()].slice(0, 3).map(([name, w]) => (
              <button
                key={name}
                className="rail-live-row"
                onClick={() => setPane({ kind: "watch", agent: name })}
              >
                <span className="rail-live-spin">⚙</span>
                <span className="rail-live-name">{name}</span>
                <span className="rail-live-doing">{w.activity}</span>
              </button>
            ))}
            {working.size > 3 && (
              <button className="rail-live-row more" onClick={() => setPane({ kind: "agents" })}>
                +{working.size - 3} more working
              </button>
            )}
          </div>
        )}
        {/* The fleet lives at the foot of the rail with the live
            strip and your own card — "who is working" is ambient,
            not a destination alongside inbox and docs. */}
        <button
          className={pane?.kind === "agents" ? "channel active home-link" : "channel home-link"}
          onClick={() => setPane(pane?.kind === "agents" ? undefined : { kind: "agents" })}
        >
          ⚉ agents
          {benchPending > 0 && <span className="badge">{benchPending}</span>}
        </button>
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
                    [<MenuIcon key="m" d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />, "memory", () => setPane({ kind: "memory" })],
                    ["$", "costs", () => setPane({ kind: "costs" })],
                    ["◷", "reminders", () => setPane({ kind: "reminders" })],
                    ["⊞", "extensions", () => setView({ kind: "extensions" })],
                    [<MenuIcon key="s" d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />, "skills", () => setView({ kind: "skills" })],
                  ] as [React.ReactNode, string, () => void, string?][]
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
          onSearch={() => setSearchOpen({ query: "" })}
          onNotice={(text) => { setBanner(text); setTimeout(() => setBanner(undefined), 6000); }}
          onProfile={(pk) => setPane({ kind: "profile", pk })}
          onDocs={() =>
            setPane(
              pane?.kind === "docs" && pane.channelId === scope.channelId
                ? undefined
                : { kind: "docs", channelId: scope.channelId }
            )
          }
          onCommand={runSlash}
          onOpenTool={(artifact) => setPane({ kind: "tool", artifact })}
          localAgents={localAgents}
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
          onOpenChannel={(channelId, msgId) => void openChannel(channelId, msgId)}
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
      {view.kind === "tools" && <ToolsView client={client} onOpen={(artifact) => setPane({ kind: "tool", artifact })} />}
      {view.kind === "extensions" && <SkillsView only="extensions" client={client} wire={wire} />}
      {view.kind === "skills" && <SkillsView only="skills" client={client} wire={wire} />}
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
          <button
            onClick={() => {
              toggleHide(ctxMenu.channelId);
              setCtxMenu(undefined);
            }}
            title="drop it from your sidebar on this machine only"
          >
            {hidden.has(ctxMenu.channelId) ? "▣ unhide" : "⊘ hide (just me)"}
          </button>
          {client.state.isOwner(client.pubkey) && (
            <button
              onClick={() => {
                void client.archiveChannel(ctxMenu.channelId, true).catch(() => {});
                setCtxMenu(undefined);
              }}
              title="archive for everyone — reversible, history is kept"
            >
              🗄 archive for everyone
            </button>
          )}
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
      {pane?.kind === "memory" && (
        <MemoryView
          client={client}
          wire={wire}
          channelId={scope?.channelId}
          channelName={scope ? client.state.workspace.channels.get(scope.channelId)?.name : undefined}
          onClose={() => setPane(undefined)}
        />
      )}
      {browse !== false && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setBrowse(false)}>
          <div className="search-box browse-box">
            <div className="pane-head">
              <span>channels in {client.state.workspace.name}</span>
              <button className="pane-close" onClick={() => setBrowse(false)}>✕</button>
            </div>
            <input
              className="search-input"
              autoFocus
              placeholder="filter channels…"
              value={browse.filter}
              onChange={(e) => setBrowse({ filter: e.target.value })}
            />
            <div className="search-results">
              {(() => {
                const wanted = browse.filter.trim().toLowerCase();
                const rows = [...client.state.workspace.channels.values()]
                  .filter((c) => !wanted || c.name.toLowerCase().includes(wanted))
                  .map((c) => ({ channel: c, msgs: client.messages(c.id) }))
                  .sort((a, b) => (b.msgs.at(-1)?.ts ?? 0) - (a.msgs.at(-1)?.ts ?? 0) || a.channel.name.localeCompare(b.channel.name));
                if (rows.length === 0) {
                  return <div className="pane-empty">{wanted ? `no channel matches "${wanted}"` : "no channels yet"}</div>;
                }
                return rows.map(({ channel, msgs }) => {
                  const last = msgs.at(-1);
                  const unread = unreads.get(channel.id) ?? 0;
                  const here = scope?.channelId === channel.id;
                  return (
                    <div key={channel.id} className="browse-row">
                      <span className="browse-name">
                        <span className="hash">#</span>{channel.name}
                        {muted.has(channel.id) && <span className="mute-mark" title="muted">✕</span>}
                        {unread > 0 && <span className="badge">{unread}</span>}
                        <span className="community-id">
                          {last
                            ? ` · ${client.displayName(last.authorPk)}: ${last.content.replace(/\s+/g, " ").slice(0, 46)}`
                            : " · nothing said yet"}
                        </span>
                      </span>
                      {here ? (
                        <span className="role-tag installed-tag">you're here</span>
                      ) : (
                        <button
                          className="agent-action"
                          onClick={() => {
                            setBrowse(false);
                            void openChannel(channel.id);
                          }}
                        >
                          open
                        </button>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
            <div className="settings-hint browse-hint">
              Every channel here is yours already — one roster covers the whole workspace, so there is
              nothing to join. Use manage (+) to create one, or to join another workspace.
            </div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="overlay settings-overlay" onClick={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
          <div className="settings-modal">
            <SettingsPane client={client} wire={wire} onClose={() => setSettingsOpen(false)} />
          </div>
        </div>
      )}
      {/* One extension's settings, opened from the group of channels it
          owns. The same panel object the settings pane renders — an
          extension writes it once and it appears wherever its work is. */}
      {extSettings && (
        <div className="overlay settings-overlay" onClick={(e) => e.target === e.currentTarget && setExtSettings(undefined)}>
          <div className="settings-modal ext-modal">
            {/* Title and close are pane-head's OWN children: it already
                space-betweens them, and wrapping both in a row put them
                in one box together at the left. */}
            <header className="pane-head">
              <span className="wiki-title">{extSettings}</span>
              <button className="pane-close" onClick={() => setExtSettings(undefined)}>✕</button>
            </header>
            <div className="pane-body">
              {(() => {
                // Boundaried: an extension that throws mid-render gets a
                // broken-panel card, not a blank app. Same guard
                // SkillsView already gives these panels — this call site
                // predates it and was the one place a bad extension
                // could still take the whole window down.
                const panel = extensionSettingsPanels().find((p) => p.name === extSettings);
                return panel ? <ExtensionPanel panel={panel} /> : <div className="settings-hint">this extension is no longer loaded</div>;
              })()}
            </div>
          </div>
        </div>
      )}
      {pane?.kind === "reminders" && (
        <RemindersPane
          client={client}
          wire={wire}
          onJumpToMessage={(msgId) => {
            for (const channel of client.state.workspace.channels.values()) {
              if (client.messages(channel.id).some((m) => m.id === msgId)) {
                void openChannel(channel.id, msgId);
                return;
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
          renderMd={(text) => <MdBody text={text} />}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane?.kind === "tool" && (
        <ToolPane
          artifact={pane.artifact}
          building={working.has(pane.artifact.authorName)}
          onClose={() => setPane(undefined)}
        />
      )}
      {toolConsent && (
        <div className="consent-backdrop" onClick={() => { toolConsent.resolve(false); setToolConsent(undefined); }}>
          <div className="consent-modal" onClick={(e) => e.stopPropagation()}>
            <div className="consent-title">A tool wants to act as you</div>
            <div className="consent-desc">{toolConsent.desc}</div>
            <div className="consent-hint">The tool proposes; only you can approve. This publishes with your key.</div>
            <div className="consent-actions">
              <button className="consent-deny" onClick={() => { toolConsent.resolve(false); setToolConsent(undefined); }}>Deny</button>
              <button className="consent-allow" onClick={() => { toolConsent.resolve(true); setToolConsent(undefined); }}>Allow once</button>
            </div>
          </div>
        </div>
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
          onOpenChannel={(channelId) => void openChannel(channelId)}
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
          onHistory={() => { setPane(undefined); setView({ kind: "pulse" }); }}
          onClose={() => setPane(undefined)}
        />
      )}
      {searchOpen && (
        <SearchOverlay
          client={client}
          wire={wire}
          initialQuery={searchOpen.query}
          onJump={(channelId, msgId) => void openChannel(channelId, msgId)}
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
  onSearch,
  onCommand,
  onNotice,
  onOpenTool,
  localAgents,
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
  onSearch: () => void;
  onCommand: (text: string) => Promise<string>;
  /** Surfaced to the sender — a mention that reached nobody must not be silent. */
  onNotice: (text: string) => void;
  /** Open a live tool artifact in the side pane (its handle sits in the thread). */
  onOpenTool: (artifact: Artifact) => void;
  /** Persona names on this machine — the sentinel can spawn these on a
   * mention, so mentioning one is never "reached nobody". */
  localAgents: ReadonlySet<string>;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = client.messages(channelId);
  // Extensions navigate threads through this (gui-extensions.openThreadAt):
  // parked per channel, id-guarded — see the seam's comment.
  useEffect(() => {
    setThreadOpener((forChannel, rootId) => {
      if (forChannel === channelId) setThreadRoot(rootId);
    });
    return () => setThreadOpener(undefined);
  }, [channelId]);

  const shown = threadRoot ? messages.filter((m) => m.id === threadRoot || m.rootId === threadRoot) : messages.filter((m) => !m.parentId);
  // Typed artifacts interleave by time. In the channel view, all of them;
  // in a thread, only LIVE tools — their handles are small and worth
  // having beside the conversation that built them, without dragging every
  // html/table artifact into the thread.
  type TimelineRow = { ts: number; msg?: Msg; artifact?: Artifact };
  const allArtifacts = client.artifacts(channelId);
  // A refined tool is ONE tool, not a stack. Every rebuild republishes a
  // fresh `live` artifact tagged with its thread root, so collapse them to
  // the latest per (thread, author, title) — one handle, one view. Keying
  // on the root keeps two threads' same-titled tools distinct. Non-live
  // artifacts (a distinct html/table/image each time) are left as-is.
  const latestLive = new Map<string, Artifact>();
  for (const a of allArtifacts) {
    if (a.type !== "live") continue;
    const key = [a.rootId ?? "top", a.authorName, a.title ?? ""].join(" | ");
    const prev = latestLive.get(key);
    if (!prev || a.ts > prev.ts) latestLive.set(key, a);
  }
  // One thread, one button, one pane: a tool lives in the thread that built
  // it. Inside that thread it shows its handle; the channel view shows only
  // top-level tools (no thread root) — a threaded tool is reached by opening
  // its thread, not by a handle floating loose in the channel.
  const liveTools = threadRoot
    ? [...latestLive.values()].filter((a) => a.rootId === threadRoot)
    : [...latestLive.values()].filter((a) => !a.rootId);
  // Non-live artifacts (html/image/table) render inline, but scope to their
  // thread the SAME way as tools: a thread shows its own, the channel shows
  // only top-level ones. An artifact built inside a thread stays there —
  // any agent can emit one, so this can't be loom's job alone.
  const nonLive = allArtifacts.filter((a) => a.type !== "live");
  const scopedNonLive = threadRoot ? nonLive.filter((a) => a.rootId === threadRoot) : nonLive.filter((a) => !a.rootId);
  const artifactRows = [...scopedNonLive, ...liveTools];
  const rows: TimelineRow[] = [
    ...shown.map((m) => ({ ts: m.ts, msg: m })),
    ...artifactRows.map((a) => ({ ts: a.ts, artifact: a })),
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
  const members = client.state.workspace.members;
  const amCreator = client.state.isOwner(client.pubkey);
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
    // Cleared optimistically for a snappy composer — but a throw before
    // the wire (not a member, bad scope) used to eat the typed message
    // with no trace; the catch puts the words back and says why.
    setDraft("");
    const savedBindings = bindings;
    setBindings(new Map());
    try {
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
        if (text !== target.original) await client.editMessage(channelId, target.id, text);
        return;
      }
      // Against THIS channel's roster, not every name the client has ever
      // seen — and a mention that reached nobody is said out loud, because
      // it otherwise looks exactly like one that worked.
      const resolution = client.resolveMentionsIn(text, channelId, savedBindings);
      // A name that matches a local persona isn't "unresolved" — the sentinel
      // will spawn it even though it hasn't announced yet. Only warn about
      // names that are neither members nor spawnable agents (real typos).
      const problem = describeMentionProblems({
        ...resolution,
        unresolved: resolution.unresolved.filter((n) => !localAgents.has(n.toLowerCase())),
      });
      await client.sendChannelMessage(text, { threadRootId: threadRoot, mentionPks: resolution.pubkeys });
      if (problem) onNotice(problem);
      // A mention of @fez that nothing answers must say why: 60s, then a
      // sticky note — never a fabricated message (cold-start spec).
      if (/@fez\b/i.test(text)) {
        const before = client.messages(channelId).length;
        setTimeout(() => {
          const later = client.messages(channelId).slice(before);
          const replied = later.some((m) => client.displayName(m.authorPk).toLowerCase() === "fez");
          if (!replied) {
            toast.info("@fez didn't answer in 60s — check Agents: is a model connected, and is the watcher (fez sentinel) running?", 0);
          }
        }, 60_000);
      }
    } catch (err) {
      setDraft(text);
      setBindings(savedBindings);
      toast.error(`couldn't send: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  const channelRef = client.channelRef(channelId);
  const channelName = channelRef?.name ?? channelId.slice(0, 8);
  // What a bridge wants said about this channel beside its name — the
  // branch a repo tracks. Generic: the header shows whatever `branch`
  // the channel carries, and knows nothing about GitHub.
  const channelBranch = channelRef?.meta?.branch;
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
        <div className="topbar-row">
        <span className="hash">#</span> {channelName}
        {channelBranch && !threadRoot && (
          <span className="channel-branch" title={`tracking ${channelBranch}`}>
            <span className="channel-branch-mark">⑂</span>
            {channelBranch}
          </span>
        )}
        {threadRoot && (
          <button className="thread-exit" onClick={() => setThreadRoot(undefined)}>← back to channel</button>
        )}
        {!threadRoot && (
          <span className="topbar-tools">
            {/* Global, so it leads the cluster — the rest act on this
                channel. ⌘K still works from anywhere. */}
            <button className="topbar-tool" title="search everything (⌘K)" onClick={onSearch}>
              ⌕
            </button>
            <button
              className="topbar-tool topbar-members"
              title="members"
              onClick={() => setMembersOpen((open) => !open)}
            >
              ⚉ {client.state.workspace.members.size ?? 0}
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
              <div className="self-menu-head">{client.state.workspace.members.size ?? 0} members</div>
              {[...(client.state.workspace.members.keys() ?? [])]
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
        </div>
        {/* The channel's doc belongs TO the channel, so it lives under
            the title inside the same block rather than as a strip
            floating between the header and the first message. */}
        {!threadRoot && (
          <ChannelInfo
            client={client}
            channelId={channelId}
            channelName={channelName}
            onJump={(msgId) => document.getElementById(`msg-${msgId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
          />
        )}
      </header>
      <div className="timeline" ref={timelineRef} onScroll={trackScroll}>
        {/* The two empty-state panels used to be inverted: FirstRun (the
            helpful one) required members > 1 — impossible for a fresh solo
            user — while the solo case always got a warning that pointed at
            the TUI. FirstRun now owns every empty channel; the solo note
            only accompanies channels that already have history. */}
        {messages.length === 0 && (
          <FirstRun
            client={client}
            channelName={channelName}
            onOpenAgents={onAgents}
          />
        )}
        {messages.length > 0 && (client.state.workspace.members.size ?? 0) <= 1 && (
          <div className="empty-room">
            You're the only member here so far — invite people from manage (+), or mention an agent by name to bring one in.
          </div>
        )}
        {threadRoot && (() => {
          const root = messages.find((m) => m.id === threadRoot);
          const view = root ? threadViewFor(root.content) : undefined;
          if (!root || !view) return null;
          // Boundaried like every other extension surface: a thread view
          // that throws mid-render must show a broken card, not unmount
          // the whole app (review finding F7 — the settings panels got
          // this guard earlier for exactly the same reason).
          const props = { channelId, rootId: threadRoot, rootContent: root.content };
          return (
            <div className="thread-view">
              <ExtensionPanel panel={{ name: view.name, render: () => view.render(props) }} />
            </div>
          );
        })()}
        {rows.map((row, index) => {
          if (row.artifact) {
            return (
              <div key={row.artifact.id}>
                {(index === 0 || !sameDay(rows[index - 1].ts, row.ts)) && (
                  <div className="day-divider"><span>{dayLabel(row.ts)}</span></div>
                )}
                <ArtifactCard artifact={row.artifact} onAuthor={() => onProfile(row.artifact!.authorPk)} onOpen={onOpenTool} />
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
              msg={msg}
              wire={wire}
              inThread={!!threadRoot}
              onOpenThread={() => setThreadRoot(msg.rootId ?? msg.id)}
              onEdit={() => beginEdit(msg)}
              onAuthor={() => onProfile(msg.authorPk)}
              onProfile={onProfile}
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
    try {
      if (group) await client.sendGroupDm(peers, text);
      else await client.sendDm(convoKey, text);
    } catch (err) {
      // Put the words back — a failed DM must not eat the draft.
      setDraft(text);
      toast.error(`couldn't send: ${err instanceof Error ? err.message : String(err)}`);
    }
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
              <div className="bubble-body md"><MdBody text={stripArtifactMarkers(msg.text)} /></div>
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
function ArtifactCard({ artifact, onAuthor, onOpen }: { artifact: Artifact; onAuthor: () => void; onOpen?: (artifact: Artifact) => void }) {
  // A live tool is interactive and wants room — it renders in the side
  // pane, not squeezed into the message column. The thread keeps only a
  // handle: the conversation that built it, plus a button to open it.
  if (artifact.type === "live") {
    return (
      <div className="artifact-card artifact-handle">
        <button className="tool-handle" onClick={() => onOpen?.(artifact)} title="open this tool in the side pane">
          <span className="tool-handle-icon">▣</span>
          <span className="tool-handle-title">{artifact.title ?? "live tool"}</span>
          <span className="tool-handle-by">· {artifact.authorName}</span>
          <span className="tool-handle-open">open →</span>
        </button>
      </div>
    );
  }
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

/** A small monochrome line-icon for menu/rail glyphs that have no clean
 * unicode (brain, wrench) — inherits currentColor so it matches the text
 * glyphs beside it instead of a full-color emoji. */
function MenuIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "middle" }}>
      <path d={d} />
    </svg>
  );
}

/** The workbench: a live tool given room, in the side pane. The tool
 * itself is whatever artifact viewer claims its type (for "live", the
 * sandboxed read-bridge frame). Swap semantics — the newest tool opened
 * wins the pane; the thread keeps the handles to reopen the others. */
function ToolPane({ artifact, building, onClose }: { artifact: Artifact; building?: boolean; onClose: () => void }) {
  const Viewer = viewerFor(artifact.type);
  // Keeping crystallizes a throwaway tool into the durable ▣ tools list.
  const [kept, setKept] = useState(() => isKept(artifact));
  useEffect(() => {
    const update = () => setKept(isKept(artifact));
    update();
    window.addEventListener("fez-tools-changed", update);
    return () => window.removeEventListener("fez-tools-changed", update);
  }, [artifact]);
  const toggleKeep = () => {
    const existing = keptTools().find((t) => t.content === artifact.content);
    if (existing) unkeepTool(existing.id);
    else keepTool(artifact);
  };
  return (
    <aside className="pane tool-pane">
      <header className="pane-head">
        <span>▣ {artifact.title ?? "tool"}{building && <span className="tool-building"> · building…</span>}</span>
        <span className="pane-actions">
          <button
            className="pane-close"
            title={kept ? "kept — click to remove from ▣ tools" : "keep this tool (adds it to ▣ tools)"}
            onClick={toggleKeep}
          >
            {kept ? "★" : "☆"}
          </button>
          <button className="pane-close" onClick={onClose}>✕</button>
        </span>
      </header>
      <div className="pane-body tool-pane-body">
        {Viewer ? <Viewer artifact={artifact} /> : <div className="pane-empty">no viewer for "{artifact.type}"</div>}
      </div>
    </aside>
  );
}

/** The ▣ tools gallery — kept tools, lifted out of scrollback into a
 * durable home. Click one to open it in the pane; ✕ to forget it. */
function ToolsView({ client, onOpen }: { client: FezClient; onOpen: (artifact: Artifact) => void }) {
  const [tools, setTools] = useState(() => keptTools());
  useEffect(() => {
    const update = () => setTools(keptTools());
    window.addEventListener("fez-tools-changed", update);
    return () => window.removeEventListener("fez-tools-changed", update);
  }, []);
  // Crystallize, rung 2: publish the kept tool back into its home channel
  // (fallback: the one in scope) as a user-signed artifact — it lands as a
  // normal tool handle anyone there can open and ★ keep.
  const share = async (t: KeptTool) => {
    const channelId = t.channelId ?? client.state.scope?.channelId;
    if (!channelId) {
      toast.error("no channel to share into — open a channel first");
      return;
    }
    const name = client.state.workspace.channels.get(channelId)?.name ?? "the channel";
    if (!confirm(`Share "${t.title}" into #${name}? Everyone there can open and keep it.`)) return;
    try {
      await client.publishArtifact(channelId, { type: t.type, title: t.title, content: t.content });
      toast.success(`Shared to #${name}`);
    } catch (e) {
      toast.error(`Share failed: ${String((e as Error)?.message ?? e)}`);
    }
  };
  return (
    <main className="main">
      <div className="tools-scroll">
        <div className="tools-head">
          <h2>▣ tools</h2>
          <p className="settings-hint">Tools you kept — reopen any in the pane. Ask @loom to build one, then ★ it.</p>
        </div>
        {tools.length === 0 ? (
          <div className="pane-empty">no kept tools yet — build one with @loom, open it, and hit ★</div>
        ) : (
          <div className="tools-grid">
            {tools.map((t) => (
              <div key={t.id} className="tool-tile">
                <button className="tool-tile-open" onClick={() => onOpen(toolArtifact(t))} title="open in the pane">
                  <span className="tool-tile-icon">▣</span>
                  <span className="tool-tile-title">{t.title}</span>
                  <span className="tool-tile-date">{new Date(t.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                </button>
                <button className="tool-tile-forget" style={{ right: 48 }} title="share into its channel" onClick={() => void share(t)}>
                  ⇪
                </button>
                <button
                  className="tool-tile-forget"
                  style={{ right: 26 }}
                  title="export as a publishable fez extension"
                  onClick={() =>
                    void exportTool(t)
                      .then((path) => toast.success(`Exported to ${path} — build & publish to share`))
                      .catch((e) => toast.error(`Export failed: ${String((e as Error)?.message ?? e)}`))
                  }
                >
                  ⤓
                </button>
                <button className="tool-tile-forget" title="forget this tool" onClick={() => unkeepTool(t.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
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
}: {
  client: FezClient;
  msg: Msg;
  channelId: string;
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
    void client.toggleReaction(channelId, msg.id, emoji);
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
}: {
  client: FezClient;
  msg: Msg;
  channelId: string;
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
    void client.toggleReaction(channelId, msg.id, CHOICE_EMOJI[index]);
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
  msg,
  wire,
  inThread,
  onOpenThread,
  onEdit,
  onAuthor,
  onProfile,
}: {
  client: FezClient;
  channelId: string;
    msg: Msg;
  wire: BrowserWire;
  inThread: boolean;
  onOpenThread: () => void;
  onEdit?: () => void;
  onAuthor?: () => void;
  onProfile?: (pk: string) => void;
}) {
  const mine = msg.authorPk === client.pubkey;
  const replies = client.threadReplyCount(channelId, msg.id);
  const reactions = client.reactions(msg.id);
  const pinned = client.isPinned(channelId, msg.id);
  const time = new Date(msg.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // What this message actually tagged, by name — so an @name that
  // reached nobody doesn't render as though it had.
  const taggedNames = useMemo(
    () => new Set(msg.mentionPks.map((pk) => client.displayName(pk).toLowerCase())),
    [client, msg.mentionPks]
  );
  // …plus anyone this workspace can name. Agents publish their mentions
  // without p tags — reviewer answered a plain-looking "@reviewer" — so
  // tags alone made working mentions read as typos. A name nobody here
  // answers to still renders plain, which is what the gate was for.
  const mentionNames = new Set([
    ...taggedNames,
    ...[...client.knownNames().values()].map((n) => n.toLowerCase()),
  ]);
  const openMention = (name: string) => {
    const hit = [...client.knownNames().entries()].find(([, known]) => known.toLowerCase() === name.toLowerCase());
    if (hit) onProfile?.(hit[0]);
  };
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
    const creator = client.state.workspace.owner;
    const reason = reportReason.trim();
    if (!creator || !reason) return;
    setReportOpen(false);
    setReportReason("");
    await wire.publish({
      kind: 1984,
      tags: [["p", creator]],
      content: wire.encrypt(creator, JSON.stringify({ targetPk: msg.authorPk, reason: `${reason} (msg: ${msg.content.slice(0, 60)})`, ts: Date.now() })),
    });
    setReported(true);
    setTimeout(() => setReported(false), 2500);
  };

  const react = (emoji: string) => {
    setPickerAt(undefined);
    void client.toggleReaction(channelId, msg.id, emoji);
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
            {!pinned && menuItem("pin to channel", "⚑", () => void client.pinMessage(channelId, msg.id))}
            {mine && onEdit && menuItem("edit message", "✎", onEdit)}
            {!mine && menuItem("report to community creator…", "⚑!", () => setReportOpen(true))}
            {client.canDeleteMessage(msg) && (
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
                  void client.deleteMessage(channelId, msg.id);
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
        {(() => {
          // The zsh-prompt chip: the branch the agent's checkout is ON,
          // from its own 47000 announcement — truth from the spawn, not
          // a claim in chat. Humans have no branch; nothing renders.
          const work = client.agentInfo(msg.authorPk);
          return work?.branch ? (
            <span className="branch-chip" title={work.repo ? `working ${work.repo} on ${work.branch}` : work.branch}>
              ⑂ {work.branch}
            </span>
          ) : null;
        })()}
        <span className="time">{time}</span>
        {msg.edited && <span className="time">edited</span>}
        {pinned && <span className="pin-mark" title="pinned">⚑</span>}
        {!msg.deletedBy && (
          <div className="actions">
            <button
              title="copy text"
              onClick={() => {
                void navigator.clipboard.writeText(msg.content);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "✓" : "⧉"}
            </button>
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
                if (!pinned) void client.pinMessage(channelId, msg.id);
              }}
            >
              ⚑
            </button>
            {client.canDeleteMessage(msg) && (
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
                  void client.deleteMessage(channelId, msg.id);
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
          <MdBody text={stripArtifactMarkers(stripInstallMarkers(msg.content))} tagged={mentionNames} onMention={openMention} />
        </div>
      )}
      {proposalIdsIn(msg.content).map((id) => (
        <InlineProposal key={id} id={id} />
      ))}
      {msg.content.startsWith("⛔ approval needed:") && (
        <ApprovalCard client={client} msg={msg} channelId={channelId} />
      )}
      {msg.content.startsWith("❓ choose:") && (
        <ChoiceCard client={client} msg={msg} channelId={channelId} />
      )}
      {installOffers(msg.content).length > 0 && (
        <InstallOffer content={msg.content} authorName={msg.authorName} client={client} />
      )}
      {messageDecorators()
        .filter((d) => d.match(msg.content))
        .map((d, i) => (
          <div key={`deco-${i}`} className="msg-decoration">
            {d.render({ content: msg.content, msgId: msg.id, channelId, authorName: msg.authorName })}
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

/**
 * Accent an @name only when the message really tagged someone by that
 * name. Highlighting every @word made a mention that reached nobody
 * look exactly like one that worked — the silence the send path stopped
 * producing, coming back on the way out.
 *
 * "Really tagged" means the event's p tags OR a name the workspace can
 * resolve, since agents publish mentions untagged.
 *
 * `tagged` undefined means the surface has no tags to check against: a
 * doc body's @name notifies nobody by design, and a DM reaches its
 * participants whatever you type. There the accent is typography, not
 * a claim, so every name keeps it.
 */
function renderMentions(text: string, tagged?: ReadonlySet<string>, onMention?: (name: string) => void) {
  // splitMentions, not a regex of our own: the surface that PAINTS a
  // mention and the surface that TAGS it must agree on what one is, or
  // the paint promises a reach the tag never made. A gate in fez-evals
  // holds @fezchat/client's copy to src/mentions.ts.
  return splitMentions(text).map(({ text: part, name }, index) => {
    if (!name || (tagged && !tagged.has(name.toLowerCase()))) {
      return <span key={index}>{part}</span>;
    }
    // Accented and inert reads the same as accented and live, so only
    // give it a button when there is somewhere to go.
    return onMention ? (
      <button key={index} className="mention mention-link" title={`open ${name}'s profile`} onClick={() => onMention(name)}>
        {part}
      </button>
    ) : (
      <span key={index} className="mention">{part}</span>
    );
  });
}

const IMAGE_URL = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/gi;
/** 📎 name.ext (…) url — fez-media's share line; render the blob when the NAME is an image. */
const MEDIA_LINE = /📎\s+(\S+\.(?:png|jpe?g|gif|webp|svg))\s+\([^)]*\)\s+(https?:\/\/\S+)/i;

/** Markdown body: gfm, @mention accents, external links via the OS browser, inline images. */
function MdBody({ text, tagged, onMention }: { text: string; tagged?: ReadonlySet<string>; onMention?: (name: string) => void }) {
  const images = [...new Set([...(text.match(IMAGE_URL) ?? []), ...(text.match(MEDIA_LINE) ? [text.match(MEDIA_LINE)![2]] : [])])];
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
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
          p: ({ children }) => <p>{accentMentions(children, tagged, onMention)}</p>,
          li: ({ children }) => <li>{accentMentions(children, tagged, onMention)}</li>,
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
function accentMentions(children: React.ReactNode, tagged?: ReadonlySet<string>, onMention?: (name: string) => void): React.ReactNode {
  const walk = (node: React.ReactNode): React.ReactNode => {
    if (typeof node === "string") return renderMentions(node, tagged, onMention);
    if (Array.isArray(node)) return node.map((child, i) => <span key={i}>{walk(child)}</span>);
    return node;
  };
  return walk(children);
}
