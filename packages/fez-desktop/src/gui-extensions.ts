/// <reference types="vite/client" />
import React from "react";
import { IsolatedPanelLauncher } from "./IsolatedPanelLauncher";
import { registerIsolatedContributions } from "./IsolatedContributions";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Artifact, FezClient } from "@fezchat/client";
import { parseQuery } from "@fezchat/client";
import { registerArtifactViewer, snapshotArtifactViewers } from "./artifact-viewers";
import { notifyEvent } from "./notify";
import { toast } from "./toast";
import { invitePersona } from "./invite-persona";
import type { Dispose, MountRender } from "./mount-result";
import { createGuiClient, requireGuiPermission, type GuiClient } from "./gui-client";
import { parseDeclarativeGui } from "./declarative-gui";
import { DeclarativeSettings, type SettingsHost } from "./DeclarativeSettings";
import { registerIsolatedCustomContributions } from "./IsolatedCustomContributions";

/**
 * Mirrors src/extension-permissions.ts (the eval-pinned source of truth).
 * Inlined rather than imported: the desktop bundle deliberately does not
 * depend on the CLI package, and these are a few lines. If the rules
 * change there they change here — the eval gate covers the semantics.
 */
const LEGACY_GRANT = ["read:channels", "read:agents", "commands", "ui"];
function networkAllowed(hostsIn: readonly string[], url: string): boolean {
  // "relay" resolves to this workspace's relay hosts at CALL time — the
  // extension serving relay HTTP surfaces (git's lane board) cannot know
  // the hostname at publish time, and the alternative was network:*.
  const hosts = hostsIn.flatMap((entry) => (entry === "relay" ? relayHostnames() : [entry]));
  if (hosts.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (hosts.includes("*")) return true;
  return hosts.some((entry) => (entry.startsWith(".") ? host === entry.slice(1) || host.endsWith(entry) : host === entry));
}

/** The workspace's relay hostnames, from the same source the wire boots from. */
function relayHostnames(): string[] {
  const raw = localStorage.getItem("fez-relay") ?? "";
  return raw
    .split(",")
    .map((u) => {
      try {
        return new URL(u.trim().replace(/^ws(s?):\/\//i, "http$1://")).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/**
 * The GUI extension loader — the desktop half of the multi-part package
 * contract. `fez install`/`fez link` materializes a package's gui part
 * into ~/.fez/packages/<name>/ (its manifest's fez.parts.gui names the
 * file within); at boot each is imported as an ES module (blob URL —
 * same-origin, no server) and its default export (or `activate`) is
 * called with the GUI api. Extensions bundle their own code but use
 * api.React so there's exactly one React in the page.
 *
 * v1 surface: registerArtifactViewer (the "obsidian extensions" seam),
 * registerTheme (CSS-variable packs), and the headless client.
 */

export interface GuiExtensionApi {
  /** Host-owned confirmation; cancellation never authorizes the action. */
  confirm?: (details: { title: string; body?: string; context?: string }) => Promise<boolean>;
  React: typeof React;
  parseQuery: typeof parseQuery;
  /** Absent without read:channels. Writes and crypto check their own grants. */
  client?: GuiClient;
  /**
   * Read-only view of this extension's own state file
   * (~/.fez/extension-data/<name>.json — the same namespace the
   * headless part's api.storage writes). Gui parts render state; the
   * CLI/MCP/headless side owns writes. Not permission-gated, matching
   * the headless stance.
   */
  storage: { get<T = unknown>(key: string): Promise<T | undefined> };
  /**
   * This extension's own preferences — the one part of its state file a
   * gui part may write. Mirrored state (`storage`) stays read-only: the
   * headless side rewrites it and a shared key would collide outright.
   *
   * What the scoping buys, exactly: a panel write targets only keys
   * under `prefs`, so it can never aim at a CLI-owned key like the
   * ledger. It does NOT make the write atomic against the CLI — the
   * Rust command does its own whole-file read-modify-write from a
   * different process than the node side's serialized queue, so two
   * concurrent writers can still lose one update. Key-level collision is
   * what is prevented; a lost update is not.
   *
   * This scoping is a correctness boundary, not a security one: gui
   * parts run in the page and can call any Tauri command directly
   * regardless of what this loader hands them, so it does not stop one
   * extension from writing another's prefs — only from aiming a write at
   * the CLI's own keys elsewhere in the file.
   */
  prefs: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  registerArtifactViewer: typeof registerArtifactViewer;
  /**
   * Agent personas, as files — LIST/READ/UPDATE plus the stable-key
   * invite. Gated behind the sensitive "personas" permission: a persona
   * is an agent's programming, and write access here is the power to
   * reprogram every agent on this machine. Exists so an extension can
   * ASSIGN an agent (fez-git writing `repo:` into a persona) without
   * core learning what a repo is.
   */
  /**
   * Run a binary THIS package ships — the `bin` map npm already copies to
   * ~/.fez/bin at install. Gated behind the sensitive `processes`
   * permission, because a spawned process outlives the panel that started
   * it and keeps running after fez quits.
   *
   * You name a bin, never a path: the host resolves it inside ~/.fez/bin,
   * and refuses any name your own package did not install. That refusal is
   * enforced in Rust against what install recorded, not here — a gui part
   * runs in the page and can invoke the command directly, so a check in
   * this loader would not bind anyone. What no caller can reach, whatever
   * it claims to be, is a binary no installed package shipped.
   *
   * Pass what the process should DO in `env`. Names that change how it
   * loads code rather than what it does — PATH, LD_*, DYLD_*, NODE_OPTIONS
   * — are refused. Secrets do not belong here either: a spawned agent
   * resolves its own key from fez's key store, which is what keeps agent
   * keys out of the desktop entirely.
   *
   * The host also supplies FEZ_OWNER_PK and FEZ_WORKSPACE_RELAY under
   * every spawn, so a spawned agent can report to its owner without the
   * extension having to learn either. The caller's env wins on collision.
   */
  /**
   * A native notification through the host's notifier (permission
   * `notifications`). The user's notification settings still gate and
   * voice it — `kind` picks the category: "agent_error" for failures,
   * "needs_action" (default) for things the owner should act on.
   */
  notify?: (title: string, body: string, kind?: "agent_error" | "needs_action") => void;
  /**
   * A toast through the host's app-wide layer (toast.ts) — the same
   * toasts core fires, so extension feedback isn't trapped in the pane
   * that produced it. Gated on `ui`.
   */
  toast?: (message: string, variant?: "success" | "error" | "warn" | "info") => void;
  agents?: {
    /** Start `bin` as an agent called `name`; resolves to its pid. */
    spawn(bin: string, opts: { name: string; env?: Record<string, string> }): Promise<number>;
    /** Stop it. True when something was actually running. */
    stop(name: string): Promise<boolean>;
    /** Whether an agent by that name is running right now. */
    isRunning(name: string): Promise<boolean>;
    lastExit?(agent: string, bin: string): Promise<string | null>;
  };
  /** One-shot sibling of `agents`: run a bin this package ships, to
   * completion, and get its output — owner-side ceremonies (the wallet's
   * init/derive is the founding case). Same grant, same Rust-side bin
   * ownership check; absent without `processes`. */
  processes?: {
    run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  };

  personas?: {
    list(): Promise<string[]>;
    read(name: string): Promise<string>;
    update(name: string, content: string): Promise<void>;
    /** Create a NEW persona file — how a twin is minted. */
    create(name: string, content: string): Promise<void>;
    /** Roster the persona's stable key now, pre-spawn. */
    invite(name: string, role?: "bot" | "member"): Promise<"invited" | "no-key" | "unknown">;
  };
  /**
   * A lens on a whole thread, keyed off its root's content. `render` may
   * take a trailing host node and return a disposer (the mount form)
   * instead of an element.
   */
  registerThreadView: (
    name: string,
    match: (rootContent: string) => boolean,
    render: (props: ThreadViewProps, host?: HTMLElement) => React.ReactNode | Dispose | void
  ) => void;
  /** Open the live activity pane for an agent, by name. */
  watchAgent: (name: string) => void;
  /** Open a guest thread — a PUBLIC conversation with a foreign market
   * npub, rendered in the host's DM rail (guest-threads spec). */
  openGuestDm: (guest: { pk: string; relay: string; name?: string; picture?: string; rateTaoHr?: number; draft?: string }) => void;
  /** Navigate to a native channel thread, including from another view. */
  openThread: (channelId: string, rootId: string) => void;
  /** Open the native channel Activity. Absent without `ui`. */
  openChannel?: (id: string) => void;
  /** Replace the side pane; the host owns close, replacement, and unload disposal. */
  openPanel?: (title: string, render: MountRender) => void;
  /** A palette, or a { light, dark } pair that follows the OS. */
  registerTheme: (name: string, vars: ThemePack) => void;
  /** Decorate chat messages below the body, or replace it with a structured view.
   * A null render keeps the normal body; the signed author stays visible. */
  registerMessageDecorator: (
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => React.ReactNode,
    options?: { replaceBody?: boolean }
  ) => void;
  /** Add a slash command to the GUI composer (/name). */
  registerGuiCommand: (name: string, run: (args: string) => Promise<string> | string) => void;
  /** A card on the extensions page where this extension is configured. */
  /**
   * A card in settings. `opts.source` names the channel source this
   * panel configures, which is what lets the rail's group for those
   * channels offer a settings button.
   */
  registerSettingsPanel: (
    name: string,
    render: MountRender,
    opts?: { source?: string }
  ) => void;
  /** Extra facts in an agent's reputation view, owned by this extension. */
  registerAgentProfileSection: (label: string, render: AgentProfileSection["render"]) => void;
  /**
   * This extension's own secrets, namespaced to it, and WRITE-ONLY —
   * `set` and `has`, never `get`. Consumers (a poller or spawned agent)
   * read the value host-side. This API has no read operation; it does
   * not sandbox code with access to the shared webview's native bridge.
   */
  secrets: {
    set(key: string, value: string): Promise<void>;
    has(key: string): Promise<boolean>;
  };
  /** Explicit transport for libraries that otherwise use globalThis.fetch. */
  fetch: typeof globalThis.fetch;
  /** Open a link in the real browser — an OAuth page, a repo. */
  openUrl(url: string): Promise<void>;
  /**
   * Extend markdown PARSING everywhere docs render — a remark plugin
   * (callouts, math, footnotes…). Runs after remark-gfm.
   */
  registerMarkdownPlugin: (plugin: unknown) => void;
  /**
   * Own a fenced block by its language tag: ```<lang> … ``` renders with
   * your component instead of a code block. The doc context comes with
   * it, so a block can publish (comments, docs) as the viewer.
   */
  registerBlockRenderer: (
    lang: string,
    render: (props: BlockProps, host?: HTMLElement) => React.ReactNode | Dispose | void,
    /**
     * What this block looks like in the doc editor's `/` menu. Without
     * it a block type is invisible: you can only insert one by already
     * knowing its fence exists, which is how every block we shipped
     * stayed undiscoverable.
     */
    menu?: BlockMenuItem
  ) => void;
  /**
   * Offer another way to look at a WHOLE document — a board, a calendar,
   * a deck. `match` decides whether this document is yours; returning
   * "default" opens in your view instead of markdown, `true` only adds
   * the toggle. The markdown is always one click away, because the
   * document is the truth and a view is a lens on it.
   */
  registerPageView: (
    name: string,
    match: (content: string) => boolean | "default",
    render: (props: PageViewProps, host?: HTMLElement) => React.ReactNode | Dispose | void
  ) => void;
  /**
   * A top-level view in the rail, beside inbox and docs — how a feature
   * that is a PLACE (loom's kept-tools gallery, a board) gets one without
   * core growing it. The host owns the button and the <main> shell; the
   * extension owns everything inside.
   */
  registerNavView: (
    name: string,
    opts: { glyph: string; label: string; channelWorkspace?: ChannelWorkspace },
    render: MountRender
  ) => void;
  /**
   * An action mounted in an open artifact pane's header, next to ✕. The
   * component receives the artifact and owns its own state — loom's ★
   * keep enters here, so core never learns what "keeping" is. `render`
   * may take a trailing host node and return a disposer (the mount form)
   * instead of an element.
   */
  registerArtifactAction: (
    name: string,
    render: (props: { artifact: Artifact }, host?: HTMLElement) => React.ReactNode | Dispose | void
  ) => void;
  /** Open an artifact in the tool pane — the same swap-semantics pane a
   * thread's tool handle opens. */
  openTool: (artifact: Artifact) => void;
  /**
   * Write a scaffolded extension package to ~/fez-tools/<slug> — the
   * host-side, path-bounded export command. The extension supplies the
   * file CONTENTS; where they may land is not negotiable from here.
   */
  exportTool: (files: { slug: string; guiJs: string; pkgJson: string; readme: string }) => Promise<string>;
}

/**
 * What a page view receives. `save` is the whole write path: hand it the
 * next markdown and it publishes a version — the view never learns the
 * difference between a wiki page and a channel doc, or what a base id
 * is. `comment` anchors a thread to a line, which is how a card becomes
 * an agent's work.
 */
export interface PageViewProps {
  content: string;
  /** Opaque document version used to reject stale isolated edits. */
  versionId?: string;
  // The optional callback is host-owned; isolated bundles only receive the data-only broker API.
  save: (next: string, beforePublish?: () => Promise<void>) => Promise<void>;
  comment: (text: string, anchor: string, mentions: string[], beforePublish?: () => Promise<void>) => Promise<void>;
  title: string;
  channelId: string;
    slug?: string;
  /** False for historical versions or without publish permission. */
  editable: boolean;
}

/** A `/` menu entry: what it's called, and what typing it inserts. */
export interface BlockMenuItem {
  label: string;
  description?: string;
  /** Markdown inserted at the caret. `$0` marks where the caret lands. */
  template: string;
  /** Words that should also match it while typing. */
  keywords?: string[];
}

/** What a block renderer receives: its own source plus where it lives. */
export interface BlockProps {
  /** everything after the language tag on the fence line, e.g. `agent=researcher refresh=daily` */
  info: string;
  /** the block's body text */
  body: string;
  /** the whole fenced block verbatim — the anchor for a comment on it */
  raw: string;
  channelId: string;
    /** wiki page slug, absent for a channel doc */
  slug?: string;
}

// ── decorator + command registries (host side of the seams) ────────
export interface MessageDecorator {
  match: (content: string) => boolean;
  render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => React.ReactNode;
  replaceBody?: boolean;
}
const decorators: MessageDecorator[] = [];
export function registerMessageDecorator(match: MessageDecorator["match"], render: MessageDecorator["render"], options?: { replaceBody?: boolean }): void {
  decorators.push({ match, render, replaceBody: options?.replaceBody });
}
export function messageDecorators(): readonly MessageDecorator[] {
  return decorators;
}

/** A presentation never changes the signed author or the original copy/reply content. */
export function messagePresentation(props: Parameters<MessageDecorator["render"]>[0]): { body: React.ReactNode; decorations: React.ReactNode[] } {
  let body: React.ReactNode;
  const decorations: React.ReactNode[] = [];
  for (const decorator of decorators) {
    if (!decorator.match(props.content)) continue;
    const node = decorator.render(props);
    if (node == null || node === false) continue;
    if (decorator.replaceBody) body ??= node;
    else decorations.push(node);
  }
  return { body, decorations };
}

/**
 * An extension's own settings, rendered on the extensions page.
 *
 * The gap this fills: an extension could decorate a message, own a
 * document view, or add a slash command — but had nowhere to put the
 * one thing almost every non-trivial extension needs, which is a place
 * to be SET UP. fez-github made that concrete: connecting an account
 * and choosing repos meant hand-editing settings.json and a dotfile,
 * because no seam existed for the extension to ask.
 *
 * The panel is a plain component. It gets nothing but its own name —
 * anything it needs (relay, keychain) it reaches the same way the rest
 * of the webview does, which keeps this seam from growing a surface of
 * its own every time an extension wants something new.
 */
export interface SettingsPanel {
  /** The extension's name, used as the card's heading. */
  name: string;
  render: MountRender;
  /**
   * The channel `source` this panel configures, when it configures one.
   *
   * A bridge opens channels stamped with a source ("github"), and the
   * rail groups them under that heading. Naming the source here is what
   * lets the group offer a settings button WITHOUT the rail knowing
   * what GitHub is: it asks which panel claims this source and renders
   * whatever answers. The next bridge gets the button by declaring it.
   */
  source?: string;
}
const settingsPanels: SettingsPanel[] = [];
export function registerSettingsPanel(
  name: string,
  render: SettingsPanel["render"],
  opts?: { source?: string }
): void {
  const panel: SettingsPanel = { name, render, source: opts?.source };
  // Re-registering replaces, so a reload cannot stack two copies of the
  // same card — the same rule registerSystemPromptSection uses.
  const at = settingsPanels.findIndex((existing) => existing.name === name);
  if (at >= 0) settingsPanels[at] = panel;
  else settingsPanels.push(panel);
}
export function extensionSettingsPanels(): readonly SettingsPanel[] {
  return settingsPanels;
}

export interface AgentProfileContext {
  pubkey: string;
  /** A local persona name; absent for foreign agents. Never infer it from a display name. */
  persona?: string;
}
export interface AgentProfileSection {
  source: string;
  label: string;
  render: (props: AgentProfileContext, host?: HTMLElement) => ReturnType<MountRender>;
}
const agentProfileSections: AgentProfileSection[] = [];
export function extensionAgentProfileSections(): readonly AgentProfileSection[] {
  return agentProfileSections;
}

/** The panel that configures a bridge's channels, if one claims them. */
export function settingsPanelForSource(source: string): SettingsPanel | undefined {
  return settingsPanels.find((panel) => panel.source === source);
}

type GuiCommand = { run: (args: string) => Promise<string> | string; ext?: string };
const guiCommands = new Map<string, GuiCommand>();
// `ext` is filled by the loader (below), never by the extension — it names
// the package a command came from so the composer palette can show it.
export function registerGuiCommand(name: string, run: (args: string) => Promise<string> | string, ext?: string): void {
  guiCommands.set(name.toLowerCase(), { run, ext });
}
export function guiCommand(name: string): ((args: string) => Promise<string> | string) | undefined {
  return guiCommands.get(name.toLowerCase())?.run;
}
/** The registered extension commands, for the composer's "/" hints. */
export function guiCommandMenu(): { name: string; args: string; description: string }[] {
  return [...guiCommands].map(([name, { ext }]) => ({
    name,
    args: "",
    description: ext ? `from ${ext}` : "extension command",
  }));
}

// ── markdown extension registries (the doc-side seam) ──────────────
const markdownPlugins: unknown[] = [];
export function registerMarkdownPlugin(plugin: unknown): void {
  markdownPlugins.push(plugin);
}
export function docMarkdownPlugins(): readonly unknown[] {
  return markdownPlugins;
}

type BlockRender = (props: BlockProps, host?: HTMLElement) => React.ReactNode | Dispose | void;
const blockRenderers = new Map<string, BlockRender>();
const blockMenu: BlockMenuItem[] = [];
export function registerBlockRenderer(lang: string, render: BlockRender, menu?: BlockMenuItem): void {
  blockRenderers.set(lang.toLowerCase(), render);
  if (menu) blockMenu.push(menu);
}
/** Extension-contributed `/` entries — a block installed is a block offered. */
export function extensionBlockMenu(): readonly BlockMenuItem[] {
  return blockMenu;
}
export function blockRenderer(lang: string): BlockRender | undefined {
  return blockRenderers.get(lang.toLowerCase());
}

export interface PageView {
  isolated?: boolean;
  name: string;
  match: (content: string) => boolean | "default";
  render: (props: PageViewProps, host?: HTMLElement) => React.ReactNode | Dispose | void;
}
/**
 * Thread views — a lens on a whole THREAD, the way a page view is a
 * lens on a document. `match` reads the thread ROOT's content (that is
 * where structured threads carry their marker — fez-git's ⑂ roots);
 * the winning view renders ABOVE the replies rather than replacing
 * them: a board is an index of the conversation, not a substitute.
 */
export interface ThreadViewProps {
  channelId: string;
  rootId: string;
  rootContent: string;
}
interface ThreadView {
  name: string;
  match: (rootContent: string) => boolean;
  render: (props: ThreadViewProps, host?: HTMLElement) => React.ReactNode | Dispose | void;
}
const threadViews: ThreadView[] = [];
export function registerThreadView(name: string, match: ThreadView["match"], render: ThreadView["render"]): void {
  threadViews.push({ name, match, render });
}
export function threadViewFor(rootContent: string): ThreadView | undefined {
  return threadViews.find((view) => {
    try {
      return view.match(rootContent);
    } catch {
      return false;
    }
  });
}

/**
 * The watch pane, as a capability. Extensions say "show me this agent
 * working"; WHERE that appears stays the host's business — the pane is
 * App state, so App parks its opener here at mount.
 */
let watchOpener: ((agent: string) => void) | undefined;
export function setWatchOpener(open: ((agent: string) => void) | undefined): void {
  watchOpener = open;
}
export function openWatch(agent: string): void {
  watchOpener?.(agent);
}

/**
 * Guest DMs, as a capability (guest-threads spec): an extension says
 * "open a conversation with this market npub" — the thread surface, the
 * ledger, and the venue-relay client are all the host's business. Same
 * parking pattern as the watch pane.
 */
let guestDmOpener: ((guest: { pk: string; relay: string; name?: string; picture?: string; rateTaoHr?: number; draft?: string }) => void) | undefined;
export function setGuestDmOpener(open: typeof guestDmOpener): void {
  guestDmOpener = open;
}
export function openGuestDm(guest: { pk: string; relay: string; name?: string; picture?: string; rateTaoHr?: number; draft?: string }): void {
  guestDmOpener?.(guest);
}

/**
 * Thread navigation, as a capability: extensions say "open this thread"
 * (a lane from the board, a line from its channel chip). App owns the
 * opener so navigation also works while no channel view is mounted.
 */
let threadOpener: ((channelId: string, rootId: string) => void) | undefined;
export function setThreadOpener(open: ((channelId: string, rootId: string) => void) | undefined): void {
  threadOpener = open;
}
export function openThreadAt(channelId: string, rootId: string): void {
  threadOpener?.(channelId, rootId);
}

let channelOpener: ((id: string) => void) | undefined;
export function setChannelOpener(open: typeof channelOpener): void {
  channelOpener = open;
}
export function openChannelAt(id: string): void { channelOpener?.(id); }

// The returned disposer closes only this opening, never a replacement pane.
let panelOpener: ((title: string, render: MountRender) => Dispose) | undefined;
export function setPanelOpener(open: typeof panelOpener): void {
  panelOpener = open;
}

const pageViews: PageView[] = [];
export function registerPageView(name: string, match: PageView["match"], render: PageView["render"], options?: { isolated: boolean }): void {
  pageViews.push({ name, match, render, ...options });
}

/** A rail entry owned by an extension — see GuiExtensionApi.registerNavView. */
export interface ChannelWorkspace {
  getChannelId: () => string | undefined;
  tabs: Array<{ id: string; label: string; render: MountRender }>;
  summary?: (props: { openTab: (id: string) => void }, host?: HTMLElement) => React.ReactNode | Dispose | void;
}

export interface NavView {
  name: string;
  glyph: string;
  label: string;
  render: MountRender;
  channelWorkspace?: ChannelWorkspace;
}
const navViews: NavView[] = [];
export function registerNavView(name: string, opts: { glyph: string; label: string; channelWorkspace?: ChannelWorkspace }, render: NavView["render"]): void {
  const view: NavView = { name, ...opts, render };
  // Re-registering replaces — the settings-panel rule, so a reload
  // cannot stack two rail buttons for the same view.
  const at = navViews.findIndex((v) => v.name === name);
  if (at >= 0) navViews[at] = view;
  else navViews.push(view);
}
export function extensionNavViews(): readonly NavView[] {
  return navViews;
}

/** An extension's binding callback must not be able to break the host rail. */
export function navChannelId(view: NavView): string | undefined {
  try {
    return view.channelWorkspace?.getChannelId();
  } catch (err) {
    console.warn(`channel workspace "${view.name}" failed to resolve:`, err);
    return undefined;
  }
}

/** Header actions on an open artifact pane — see registerArtifactAction. */
export interface ArtifactAction {
  name: string;
  render: (props: { artifact: Artifact }, host?: HTMLElement) => React.ReactNode | Dispose | void;
}
const artifactActions: ArtifactAction[] = [];
export function registerArtifactAction(name: string, render: ArtifactAction["render"]): void {
  const action: ArtifactAction = { name, render };
  const at = artifactActions.findIndex((a) => a.name === name);
  if (at >= 0) artifactActions[at] = action;
  else artifactActions.push(action);
}
export function extensionArtifactActions(): readonly ArtifactAction[] {
  return artifactActions;
}

/**
 * The tool pane, as a capability — the same parked-opener pattern as the
 * watch pane: the pane is App state, extensions only get to say "open
 * this artifact there".
 */
let toolOpener: ((artifact: Artifact) => void) | undefined;
export function setToolOpener(open: ((artifact: Artifact) => void) | undefined): void {
  toolOpener = open;
}
export function openTool(artifact: Artifact): void {
  toolOpener?.(artifact);
}
/** The views that recognize this document, and which (if any) wants to open. */
export function pageViewsFor(content: string): { views: PageView[]; preferred?: string } {
  const views: PageView[] = [];
  let preferred: string | undefined;
  for (const view of pageViews) {
    let verdict: boolean | "default" = false;
    try {
      verdict = view.match(content);
    } catch {
      continue; // a view that throws on match doesn't get to break the page
    }
    if (!verdict) continue;
    views.push(view);
    if (verdict === "default" && !preferred) preferred = view.name;
  }
  return { views, preferred };
}

// ── theme registry ─────────────────────────────────────────────────
// The palette itself is pure data and lives in theme-default.ts, which
// imports nothing — so a Node test can read the token map without
// compiling React, Tauri and the DOM. Re-exported here because this is
// where the rest of the app already looks for it.
export { BUILT_IN_DEFAULT } from "./theme-default";
import { BUILT_IN_DEFAULT } from "./theme-default";
import { applyDisplayPrefs, loadDisplayPrefs } from "./display-prefs";

export type ThemeVars = Record<string, string>;
/**
 * A theme is either one palette, or a light/dark pair.
 *
 * A flat record stays legal and means "the same either way" — every
 * theme registered before this existed keeps working unchanged. A pair
 * lets a theme follow the OS, which is what "auto" resolves against.
 */
export type ThemePack = ThemeVars | { light: ThemeVars; dark: ThemeVars };

const themes = new Map<string, ThemePack>();
const THEME_KEY = "fez-gui-theme";
const MODE_KEY = "fez-gui-mode";

/** system = follow the OS. The other two override it. */
export type AppearanceMode = "system" | "light" | "dark";

const darkQuery = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;

/** What the app should actually paint right now. */
export function resolvedScheme(): "light" | "dark" {
  const mode = currentMode();
  if (mode !== "system") return mode;
  return darkQuery()?.matches === false ? "light" : "dark";
}

function variant(pack: ThemePack, scheme: "light" | "dark"): ThemeVars {
  return "light" in pack && "dark" in pack ? (pack as { light: ThemeVars; dark: ThemeVars })[scheme] : (pack as ThemeVars);
}

export function registerTheme(name: string, vars: ThemePack): void {
  themes.set(name, vars);
  if (currentTheme() === name) paint();
}

export function themeNames(): string[] {
  return [...themes.keys()].sort();
}

export function currentTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? "default";
}

export function currentMode(): AppearanceMode {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Does the chosen theme actually have both? Settings says so honestly. */
export function themeFollowsScheme(name = currentTheme()): boolean {
  const pack = name === "default" ? BUILT_IN_DEFAULT : themes.get(name);
  return !!pack && "light" in pack && "dark" in pack;
}

/** Read a palette for settings previews without repainting the workspace. */
export function themePalette(name: string, scheme: "light" | "dark"): ThemeVars {
  const pack = name === "default" ? BUILT_IN_DEFAULT : themes.get(name) ?? cachedThemePack(name);
  // Omitted tokens inherit App.css's built-in dark palette, just as paint() does.
  return { ...BUILT_IN_DEFAULT.dark, ...(pack ? variant(pack, scheme) : {}) };
}

/**
 * The chosen theme's last-resolved pack, cached across launches. The
 * palette itself lives in the themes EXTENSION, which loads after boot —
 * so without this, every non-default theme booted in the built-in ember
 * (the splash included) and snapped to itself seconds later when
 * registerTheme landed. The cache is paint of last resort: stale-tolerant
 * by design, because the canonical pack repaints over it the moment it
 * registers, and a theme that was uninstalled keeps its last look rather
 * than flashing raw CSS fallbacks.
 */
const THEME_CACHE_KEY = "fez-theme-cache";

function cacheThemePack(name: string, pack: ThemePack): void {
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ name, pack }));
  } catch {
    /* a full or blocked storage must never break paint */
  }
}

function cachedThemePack(name: string): ThemePack | undefined {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { name?: string; pack?: ThemePack };
    return parsed.name === name && parsed.pack ? parsed.pack : undefined;
  } catch {
    return undefined;
  }
}

export function applyTheme(name: string): void {
  localStorage.setItem(THEME_KEY, name);
  paint();
}

export function applyMode(mode: AppearanceMode): void {
  localStorage.setItem(MODE_KEY, mode);
  paint();
}

/**
 * Resolve theme + mode to one palette and put it on the root.
 *
 * Everything is cleared first: switching from a theme that sets
 * --font-mono to one that doesn't must not leave the old font behind,
 * and that is exactly the kind of residue an incremental setProperty
 * loop leaves.
 */
function paint(): void {
  const name = currentTheme();
  const pack = name === "default" ? BUILT_IN_DEFAULT : themes.get(name);
  document.documentElement.removeAttribute("style");
  // The class is for CSS that must branch on scheme rather than on a
  // variable — form controls, scrollbars, and the native color-scheme
  // hint that makes text inputs and menus match.
  const scheme = resolvedScheme();
  document.documentElement.dataset.scheme = scheme;
  // Tells the platform to paint scrollbars, text inputs, selects and
  // menus the right way. Without it a light theme keeps dark native
  // widgets and looks broken in exactly the places CSS can't reach.
  document.documentElement.style.colorScheme = scheme;
  // Match native sidebar material to the app's appearance override. Browser
  // previews and other platforms retain the opaque CSS fallback.
  if ("__TAURI_INTERNALS__" in window && window.__TAURI_INTERNALS__ && /Mac/i.test(navigator.platform || navigator.userAgent)) {
    void getCurrentWindow().setTheme(currentMode() === "system" ? null : scheme)
      .then(() => { document.documentElement.dataset.vibrancy = "sidebar"; })
      .catch((error) => {
        delete document.documentElement.dataset.vibrancy;
        console.warn("Native sidebar appearance unavailable", error);
      });
  }
  if (!pack) {
    // Not registered yet (its extension loads after boot) — wear the
    // cached copy of what this theme resolved to last launch, so the
    // splash and first frames keep the chosen look.
    const cached = cachedThemePack(name);
    if (cached) applyThemeVars(variant(cached, scheme));
    return;
  }
  cacheThemePack(name, pack);
  applyThemeVars(variant(pack, scheme));
}

function applyThemeVars(vars: ThemeVars): void {
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith("--")) document.documentElement.style.setProperty(key, value);
  }
}

/**
 * Start following the OS. Called once at boot; the listener stays for
 * the process, because "system" has to keep tracking after the user
 * flips their Mac to dark at sunset — a one-shot read at startup is the
 * bug this avoids.
 */
export function startAppearanceWatch(): void {
  applyDisplayPrefs(loadDisplayPrefs());
  paint();
  darkQuery()?.addEventListener("change", () => {
    if (currentMode() === "system") paint();
  });
}

// ── loader ─────────────────────────────────────────────────────────
export interface GuiExtStatus {
  name: string;
  ok: boolean;
  error?: string;
}
const status: GuiExtStatus[] = [];
/** What loaded (and what didn't, and why) — shown in settings so a
 * broken gui part is visible instead of a silently missing theme. */
export function guiExtensionStatus(): readonly GuiExtStatus[] {
  return status;
}

type Activate = (api: GuiExtensionApi) => void | Promise<void>;

/**
 * Extensions run in the page, so "gating" means: hand them a narrowed
 * api, and evaluate their bundle in a scope where the global escape
 * hatches are shadowed. The IIFE path (the one WKWebView actually uses)
 * lets us pass replacements as parameters, which is why network gating
 * is real there and best-effort on the module path.
 */
function gatedFetch(name: string, hosts: string[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!networkAllowed(hosts, url)) {
      console.warn(`⚠️  extension "${name}" blocked from fetching ${url} — no matching network: permission`);
      return Promise.reject(new Error(`fez: network access to ${url} not granted to "${name}"`));
    }
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function blockedSocket(name: string, hosts: string[]): typeof WebSocket {
  return new Proxy(WebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = String(args[0]);
      if (!networkAllowed(hosts, url)) {
        console.warn(`⚠️  extension "${name}" blocked from opening a socket to ${url}`);
        throw new Error(`fez: socket to ${url} not granted to "${name}"`);
      }
      return new target(...args);
    },
  }) as typeof WebSocket;
}

async function importModule(
  code: string,
  name: string,
  networkHosts: string[]
): Promise<{ default?: Activate; activate?: Activate }> {
  // Preferred: real ES module via blob URL…
  try {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try {
      const mod = (await import(/* @vite-ignore */ url)) as { default?: Activate; activate?: Activate };
      // An IIFE bundle imports "successfully" as an EMPTY module — only
      // accept the module path when it actually exports an activate.
      if (typeof mod?.default === "function" || typeof mod?.activate === "function") return mod;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // WKWebView has historically refused module imports from blob: URLs —
    // fall through to the IIFE path either way.
  }
  // Fallback: evaluate an IIFE bundle (esbuild --format=iife
  // --global-name=__fezExt) and pick up its exports object.
  // fetch/WebSocket/XMLHttpRequest are shadowed as PARAMETERS, so the
  // bundle's references resolve to ours instead of the page globals.
  const factory = new Function(
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    `${code}\n;return (typeof __fezExt !== "undefined" ? __fezExt : undefined);`
  );
  const denyXhr = function () {
    throw new Error(`fez: XMLHttpRequest is not available to "${name}" — use fetch with a network: permission`);
  };
  const exported = factory(gatedFetch(name, networkHosts), blockedSocket(name, networkHosts), denyXhr) as
    | { default?: Activate; activate?: Activate }
    | Activate
    | undefined;
  if (typeof exported === "function") return { default: exported };
  if (exported) return exported;
  throw new Error("neither an importable module nor an IIFE with global __fezExt");
}

/**
 * Restore core on reload, or the preceding extensions when activation
 * fails. Keep values as well as keys/lengths: registration can replace an
 * existing entry. Core registers before the first load, when baseline is captured.
 */
let baseline: Dispose | undefined;

// Companion CSS is 100% extension-owned — core never injects any — so
// unlike the registries above this needs no baseline snapshot: a reload
// can simply dispose everything and let the fresh load re-inject.
const styleDisposers = new Map<string, Dispose>();
const uiDisposers = new Map<string, Dispose>();

function snapshotArray<T>(registry: T[]): Dispose {
  const snapshot = [...registry];
  return () => { registry.splice(0, registry.length, ...snapshot); };
}

function snapshotMap<K, V>(registry: Map<K, V>): Dispose {
  const snapshot = new Map(registry);
  return () => {
    registry.clear();
    for (const [key, value] of snapshot) registry.set(key, value);
  };
}

function snapshotRegistrations(): Dispose {
  const snapshots = [
    snapshotArray(decorators),
    snapshotArray(settingsPanels),
    snapshotArray(agentProfileSections),
    snapshotMap(guiCommands),
    snapshotArray(markdownPlugins),
    snapshotMap(blockRenderers),
    snapshotArray(blockMenu),
    snapshotArray(threadViews),
    snapshotArray(pageViews),
    snapshotArray(navViews),
    snapshotArray(artifactActions),
    snapshotArtifactViewers(),
    snapshotMap(themes),
  ];
  return () => { for (const restore of snapshots) restore(); };
}

function restoreBaseline(): void {
  baseline?.();
  for (const dispose of uiDisposers.values()) dispose();
  uiDisposers.clear();
  for (const dispose of styleDisposers.values()) dispose();
  styleDisposers.clear();
  window.dispatchEvent(new CustomEvent("fez-gui-extensions-changed"));
}

/**
 * A gui part's companion CSS (a hashed CSS Module `fez pack` emitted) is
 * injected once, keyed by extension name, and removed on dispose. Hashed
 * class names mean it cannot collide with the host or another extension,
 * so this is a plain document-level <style> — no Shadow DOM needed.
 */
export function injectExtensionStyles(name: string, css: string): Dispose {
  const sel = `style[data-fez-ext="${CSS.escape(name)}"]`;
  document.head.querySelector(sel)?.remove(); // replace, don't stack
  const el = document.createElement("style");
  el.setAttribute("data-fez-ext", name);
  el.textContent = css;
  document.head.appendChild(el);
  return () => el.remove();
}

/** Unload every extension and load the current set fresh — for install/uninstall/update without a relaunch. */
export async function reloadGuiExtensions(client: FezClient): Promise<string[]> {
  return loadGuiExtensions(client);
}

let pendingLoad: Promise<unknown> = Promise.resolve();

export function loadGuiExtensions(client: FezClient): Promise<string[]> {
  // A boot load and install/update reloads share registries: finish the
  // previous activation before clearing its registrations.
  const loading = pendingLoad.then(() => loadCurrentGuiExtensions(client));
  pendingLoad = loading.catch(() => {});
  return loading;
}

async function loadCurrentGuiExtensions(client: FezClient): Promise<string[]> {
  baseline ??= snapshotRegistrations();
  restoreBaseline();
  const loaded: string[] = [];
  status.length = 0;
  type GuiPart = [name: string, code: string, styles: string, settingsSource?: string | null, runtime?: unknown, contributions?: unknown];
  let files: GuiPart[];
  try {
    files = await invoke<GuiPart[]>("list_gui_extensions");
  } catch {
    return loaded;
  }
  let grants: Record<string, string[]> = {};
  try {
    grants = JSON.parse(await invoke<string>("read_extension_grants"));
  } catch { /* no grants recorded — everything falls back to the legacy grant */ }

  for (const [name, code, styles, settingsSource, runtime, contributions] of files) {
    if (runtime != null && runtime !== "isolated-settings" && runtime !== "isolated-page" && runtime !== "declarative" && runtime !== "isolated") {
      status.push({ name, ok: false, error: "Unsupported GUI runtime — update the extension or Fez" });
      continue;
    }
    if (runtime === "isolated") {
      let active = true;
      let closePanel: Dispose | undefined;
      const rollback = snapshotRegistrations();
      try {
        if (!grants[name]?.includes("ui")) throw Error("Isolated views require a recorded ui grant");
        registerIsolatedCustomContributions(name, client, contributions, {
          openPanel: (title, render) => {
            if (!active) return;
            closePanel?.();
            closePanel = panelOpener?.(title, render);
          },
          registerAgentProfileSection: (label, render) => { agentProfileSections.push({ source: name, label, render }); },
        });
        uiDisposers.set(name, () => { active = false; closePanel?.(); });
        loaded.push(name); status.push({ name, ok: true });
      } catch (error) { active = false; closePanel?.(); rollback(); status.push({ name, ok: false, error: String(error) }); }
      continue;
    }
    if (runtime === "declarative") {
      try {
        if (!grants[name]?.includes("ui")) throw Error("Declarative GUI requires a recorded ui grant");
        const data = parseDeclarativeGui(code);
        if (data.settings) {
          const permissions = grants[name];
          const require = (permission: string) => requireGuiPermission(name, permissions, "settings", permission);
          const host: SettingsHost = {
            permissions,
            run: (bin, args) => { require("processes"); return invoke("run_extension_bin", { extension: name, bin, args }); },
            spawn: (bin, job, env) => { require("processes"); return invoke("spawn_extension_agent", { extension: name, bin, name: job, env: Object.entries(env) }); },
            isRunning: (bin, job) => { require("processes"); return invoke("agent_alive", { persona: job, bin }); },
            agents: () => { require("ui"); require("read:agents"); return [...client.agents()]; },
            readPreference: async key => { require("ui"); const state = JSON.parse(await invoke<string>("extension_storage_read", { name })); return state.prefs?.[key]; },
            writePreference: (key, value) => { require("ui"); return invoke("extension_storage_write", { name, key, value: JSON.stringify(value) }); },
            allowPreview: url => {
              require("ui");
              const hosts = permissions.filter(value => value.startsWith("network:")).map(value => value.slice(8));
              if (!networkAllowed(hosts, url)) throw Error("The preview's network permission has not been granted. Reinstall the extension and grant it to continue.");
            },
          };
          registerSettingsPanel(name, () => React.createElement(DeclarativeSettings, { sections: data.settings!, host }), { source: settingsSource ?? undefined });
        }
        for (const [theme, pack] of Object.entries(data.themes ?? {})) registerTheme(theme, pack);
        loaded.push(name);
        status.push({ name, ok: true });
      } catch (error) { status.push({ name, ok: false, error: String(error) }); }
      continue;
    }
    if (runtime === "isolated-page") {
      try {
        if (!grants[name]?.includes("ui") || !grants[name]?.includes("read:channels")) throw Error("Isolated page requires recorded ui and read:channels grants");
        registerIsolatedContributions(name, client, contributions);
        loaded.push(name);
        status.push({ name, ok: true });
      } catch (error) { status.push({ name, ok: false, error: String(error) }); }
      continue;
    }
    if (runtime === "isolated-settings") {
      // Intercept before bundle evaluation or CSS injection into main.
      // Rust independently checks the grants when this is opened.
      if (!grants[name]?.includes("ui")) {
        status.push({ name, ok: false, error: "Isolated panel requires a recorded ui grant" });
        continue;
      }
      registerSettingsPanel(name, () => React.createElement(IsolatedPanelLauncher, { name, client }), { source: settingsSource ?? undefined });
      loaded.push(name);
      status.push({ name, ok: true });
      continue;
    }
    // `styles` is the gui part's companion CSS (the hashed `<gui>.css`
    // `fez pack` emits, returned by the Rust scan beside the code). Empty
    // string for the common no-CSS-module case, so injection below is a
    // no-op unless there is actually CSS to inject.
    const granted = grants[name] ?? LEGACY_GRANT;
    const may = (permission: string) => granted.includes(permission);
    const hosts = granted.filter((g) => g.startsWith("network:")).map((g) => g.slice("network:".length));
    const refuse = (permission: string, what: string) => () =>
      console.warn(`⚠️  extension "${name}" tried to ${what} without "${permission}" — ignored`);
    let active = true;
    let closePanel: Dispose | undefined;
    const disposeUi = () => { active = false; closePanel?.(); };
    const api: GuiExtensionApi = {
      React,
      fetch: gatedFetch(name, hosts),
      // Parse a natural-language query into the shape client.runQuery wants
      // — the seam an exported tool needs to answer its own data.
      parseQuery,
      client: may("read:channels") ? createGuiClient(client, name, granted) : undefined,
      // Read-only view of this extension's own state file — the gui
      // half of headless api.storage. Namespace-locked to `name` here;
      // the Rust command only re-checks the name can't traverse.
      storage: {
        get: async <T = unknown>(key: string): Promise<T | undefined> => {
          try {
            const raw = await invoke<string>("extension_storage_read", { name });
            const data = JSON.parse(raw) as Record<string, unknown>;
            return data[key] as T | undefined;
          } catch {
            return undefined;
          }
        },
      },
      prefs: {
        get: async <T = unknown>(key: string): Promise<T | undefined> => {
          try {
            const raw = await invoke<string>("extension_storage_read", { name });
            const data = JSON.parse(raw) as { prefs?: Record<string, unknown> };
            return data.prefs?.[key] as T | undefined;
          } catch {
            return undefined;
          }
        },
        set: async (key: string, value: unknown): Promise<void> => {
          await invoke("extension_storage_write", { name, key, value: JSON.stringify(value) });
        },
      },
      registerArtifactViewer: may("ui") ? registerArtifactViewer : (refuse("ui", "register an artifact viewer") as never),
      registerTheme: may("ui") ? registerTheme : (refuse("ui", "register a theme") as never),
      registerMessageDecorator: may("ui") ? registerMessageDecorator : (refuse("ui", "decorate messages") as never),
      registerBlockRenderer: may("ui") ? registerBlockRenderer : (refuse("ui", "render doc blocks") as never),
      registerPageView: may("ui")
        ? (label, match, render) => registerPageView(label, match, (props, host) => render({
            ...props,
            editable: props.editable && may("publish"),
            save: async (next) => {
              requireGuiPermission(name, granted, "page.save", "publish");
              await props.save(next);
            },
            comment: async (text, anchor, mentions) => {
              requireGuiPermission(name, granted, "page.comment", "publish");
              await props.comment(text, anchor, mentions);
            },
          }, host))
        : (refuse("ui", "add a page view") as never),
      registerMarkdownPlugin: may("ui") ? registerMarkdownPlugin : (refuse("ui", "extend markdown") as never),
      registerGuiCommand: may("commands")
        ? ((cmd: string, run: (args: string) => Promise<string> | string) => registerGuiCommand(cmd, run, name))
        : (refuse("commands", "add a slash command") as never),
      // Keyed by the EXTENSION's name, not one it picks: two packages
      // must not be able to claim the same card, and a card should say
      // which extension it configures.
      // Namespaced to THIS extension: one package cannot read or clobber
      // another's credential by naming it.
      secrets: {
        set: (key: string, value: string) =>
          may("ui")
            ? invoke<void>("set_skill_secret", { skill: name, key, value })
            : Promise.resolve(refuse("ui", "store a secret")() as void),
        has: (key: string) =>
          may("ui") ? invoke<boolean>("has_skill_secret", { skill: name, key }) : Promise.resolve(false),
      },
      openUrl: (url: string) => (may("ui") ? openUrl(url) : Promise.resolve(refuse("ui", "open a link")() as void)),
      // `extension` is passed for the caller rather than taken from it: a
      // well-behaved package never has to name itself, and a badly-behaved
      // one naming someone else gains nothing the host will honour.
      // The user's notification settings still gate and voice these —
      // the permission grants access to the notifier, not a bypass of it.
      notify: may("notifications")
        ? (title: string, body: string, kind?: "agent_error" | "needs_action") =>
            notifyEvent({
              key: `ext:${name}:${title}`,
              kind: kind === "agent_error" ? "agent_error" : "needs_action",
              title,
              body,
              label: name,
            })
        : undefined,
      toast: may("ui")
        ? (message: string, v?: "success" | "error" | "warn" | "info") => toast[v ?? "info"](message)
        : undefined,
      agents: may("processes")
        ? {
            spawn: (bin: string, opts: { name: string; env?: Record<string, string> }) =>
              invoke<number>("spawn_extension_agent", {
                extension: name,
                bin,
                name: opts.name,
                // Two host facts under every spawn — owner and workspace
                // relay — so a spawned agent can report to its owner
                // (owner-encrypted 47030s, say) without the extension
                // having to learn either. The caller's env wins.
                env: Object.entries({
                  FEZ_OWNER_PK: client.pubkey,
                  FEZ_WORKSPACE_RELAY: (localStorage.getItem("fez-relay") ?? "").split(",")[0]?.trim() ?? "",
                  ...(opts.env ?? {}),
                }),
              }),
            // `bin` scopes both to the caller's own processes — "drift"
            // the miner must never stop "drift" the chat agent.
            stop: (agent: string, bin?: string) => invoke<boolean>("kill_agent", { persona: agent, bin: bin ?? null }),
            isRunning: (agent: string, bin?: string) => invoke<boolean>("agent_alive", { persona: agent, bin: bin ?? null }),
            /** Why the last run under this name+bin ended — the row's
             * feedback when a spawn dies seconds after starting. */
            lastExit: (agent: string, bin: string) => invoke<string | null>("agent_last_exit", { persona: agent, bin }),
          }
        : undefined,
      // One-shot sibling of `agents` — same grant, same Rust-side bin
      // ownership check (run_extension_bin), different shape: runs to
      // completion and returns the output, for owner-side ceremonies a
      // panel drives (the wallet's init/derive is the founding case).
      processes: may("processes")
        ? {
            run: (bin: string, args: string[]) =>
              invoke<{ code: number; stdout: string; stderr: string }>("run_extension_bin", { extension: name, bin, args }),
          }
        : undefined,
      personas: may("personas")
        ? {
            list: () => invoke<string[]>("list_personas"),
            read: (p: string) => invoke<string>("read_persona", { name: p }),
            update: (p: string, content: string) => invoke<void>("update_persona", { name: p, content }),
            create: async (p: string, content: string) => {
              await invoke<string>("write_persona", { name: p, content });
            },
            invite: async (p: string, role?: "bot" | "member") => (await invitePersona(client, p, role ?? "bot")).kind,
          }
        : undefined,
      registerThreadView: may("ui") ? registerThreadView : (refuse("ui", "add a thread view") as never),
      registerNavView: may("ui") ? registerNavView : (refuse("ui", "add a rail view") as never),
      registerArtifactAction: may("ui") ? registerArtifactAction : (refuse("ui", "add an artifact action") as never),
      openTool: may("ui") ? openTool : (refuse("ui", "open the tool pane") as never),
      exportTool: may("ui")
        ? (files: { slug: string; guiJs: string; pkgJson: string; readme: string }) =>
            invoke<string>("export_tool", files)
        : (refuse("ui", "export a tool package") as never),
      openThread: may("ui") ? (id, rootId) => { if (active) openThreadAt(id, rootId); } : (refuse("ui", "navigate threads") as never),
      openChannel: may("ui") ? (id) => { if (active) channelOpener?.(id); } : undefined,
      openPanel: may("ui") ? (title, render) => {
        if (!active) return;
        closePanel?.();
        closePanel = panelOpener?.(title, render);
      } : undefined,
      watchAgent: may("read:agents") ? openWatch : (refuse("read:agents", "open the watch pane") as never),
      // Forward surface (guest-threads spec): typed loosely so extensions
      // built against an older api still load; the host validates the pk.
      openGuestDm: may("ui")
        ? (guest: { pk: string; relay: string; name?: string; picture?: string; rateTaoHr?: number; draft?: string }) => {
            if (!/^[0-9a-f]{64}$/.test(guest.pk) || !/^wss?:\/\//.test(guest.relay)) return;
            openGuestDm(guest);
          }
        : (refuse("ui", "open a guest DM") as never),
      // The label is ignored on purpose — a panel is filed under the
      // extension's own name, so one cannot present itself as another.
      // `opts` is NOT ignored: it carries which channel source this
      // panel configures, and dropping it silently was why the rail's
      // group had no settings button.
      registerSettingsPanel: may("ui")
        ? (_label: string, render: MountRender, opts?: { source?: string }) =>
            registerSettingsPanel(name, render, opts)
        : (refuse("ui", "add a settings panel") as never),
      registerAgentProfileSection: may("ui")
        ? (label, render) => {
            const section = { source: name, label, render };
            const at = agentProfileSections.findIndex((s) => s.source === name && s.label === label);
            if (at >= 0) agentProfileSections[at] = section;
            else agentProfileSections.push(section);
          }
        : (refuse("ui", "add an agent profile section") as never),
    };
    const rollback = snapshotRegistrations();
    try {
      const mod = await importModule(code, name, hosts);
      const activate = mod.default ?? mod.activate;
      if (typeof activate !== "function") throw new Error("no default export / activate()");
      await activate(api);
      if (styles) styleDisposers.set(name, injectExtensionStyles(name, styles));
      uiDisposers.set(name, disposeUi);
      loaded.push(name);
      status.push({ name, ok: true });
      console.log(`🧩 gui extension loaded: ${name}`);
    } catch (err) {
      disposeUi();
      rollback();
      status.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
      console.error(`🧩 gui extension "${name}" failed to load:`, err);
    }
  }
  // Extensions load AFTER the shell mounts; anything rendering from these
  // registries (the rail's nav views) hears this and re-reads.
  window.dispatchEvent(new CustomEvent("fez-gui-extensions-changed"));
  return loaded;
}
