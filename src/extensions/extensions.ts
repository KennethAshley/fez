import { fezHome } from "../shared/fez-home.js";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { McpServer } from "@agentclientprotocol/sdk";
import { makeChannels, type ChannelsAccess } from "../protocol/channels.js";
import type { Event, Filter } from "nostr-tools";
import { registerHarness, type HarnessAdapter } from "../agent/harness.js";
import type { DmRumor } from "../protocol/dm.js";
import type { FezClient } from "../../packages/fez-client/dist/index.js";
import { registerMcpServer } from "./mcp-servers.js";
import { registerCommand, type CommandHandler } from "../cli/commands.js";
import { setStatus } from "../cli/status.js";
import { registerSystemPromptSection } from "../agent/system-prompt.js";
import { LEGACY_GRANT } from "./extension-permissions.js";
import { makeStorage, type StorageAccess } from "./extension-storage.js";

/**
 * API surface handed to extension files. Deliberately small — grows as
 * Fez grows, one method at a time (pi's ExtensionAPI has ~10x this after
 * years of use; starting minimal beats guessing at surface nobody needs yet).
 *
 * Everything an installed extension can do comes off this object — an
 * installed entry is a single bundled file in ~/.fez/extensions/ with no
 * reachable node_modules, so bare imports of fez internals or pi-tui would
 * not resolve. That's why the UI surface is handles and callbacks
 * (createSidePanel -> setText) rather than component types.
 *
 * `ui.setStatus` — footer segments (pi's ctx.ui.setStatus shape).
 * `ui.createSidePanel` — a text panel docked left of the chat (the
 *   communities sidebar is the reference consumer).
 * `ui.appendMessage` — render a chat bubble into the log (incoming
 *   relay messages).
 * `registerInputHandler` — claim non-command chat input before fez's
 *   default @mention/orchestrator routing; return true = handled.
 * `nostr` — publish (signed with the user's key) / subscribe / query on
 *   fez's relay. Undefined outside the TUI (CLI subcommands) — guard on it.
 */
export interface NostrAccess {
  pubkey: string;
  publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<Event>;
  /**
   * Sign WITHOUT publishing — for events that travel outside the relay
   * (Blossom/NIP-98 HTTP auth headers). The private key stays behind the
   * seam, as with publish.
   */
  signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Event;
  subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void;
  query(filters: Filter[]): Promise<Event[]>;
  /** NIP-44 with the user's key — private pipes over public relays (observer frames, DMs). */
  encrypt(peerPubkey: string, plaintext: string): string;
  /** Throws on wrong key/garbage — callers decide whether that's ignorable. */
  decrypt(peerPubkey: string, ciphertext: string): string;
  /** NIP-17 private DM as the user: wraps to recipient + self-copy, publishes both. Resolves to the rumor id. */
  sendDm(recipientPubkey: string, text: string): Promise<string>;
  /** Unwrap a kind-1059 gift wrap addressed to the user; undefined if not ours / not a DM. */
  unwrapDm(event: Event): DmRumor | undefined;
}

/**
 * The workspace this process is attached to, as the relay describes it.
 *
 * Extensions kept needing two facts neither `nostr` nor `client` could
 * give them: which relay this is, and who owns it. Without them the only
 * options were to derive a URL from the websocket address (wrong behind
 * any proxy) or assume the local key is the owner (wrong on every relay
 * you didn't create) — and both fail silently, which is why this exists
 * rather than a pair of conventions.
 *
 * `info` is the relay's whole NIP-11 document, including fields
 * contributed by ITS relay extensions. That is how a client learns where
 * something like git lives: the relay says so, rather than each client
 * reconstructing it. Anything in here is the relay's own claim about
 * itself — treat it as a hint for reaching the relay, never as authority
 * over what an event means.
 */
export interface WorkspaceAccess {
  /** The relay's websocket URL, as this process connected to it. */
  relayUrl?: string;
  /**
   * Owner pubkey from NIP-11. Undefined means the workspace is
   * UNCLAIMED — no channel, roster or ban event can be valid on it.
   */
  owner?: string;
  /** The relay's NIP-11 document, verbatim. */
  info?: Record<string, unknown>;
}

export interface PanelHandle {
  setText(text: string): void;
}

/**
 * Handle to a rendered chat bubble — lets the creator mutate it in place
 * after the fact (live reaction rows, updating reply counts, streaming
 * content) instead of appending corrections to an append-only log.
 */
export interface MessageHandle {
  setAuthor(author: string): void;
  setContent(content: string): void;
  /** Dim single line under the bubble — reaction row, reply count, etc. Empty string hides it. */
  setFooter(text: string): void;
  /** Extra segment on the message's action footer (after copy/quote) — reply counts, /thread links. Pre-styled by the caller; empty string clears. */
  setMeta(text: string): void;
}

/**
 * Cross-extension view ownership for the chat log. Exactly one owner at
 * a time; "channel" is the default timeline (fez-communities). An
 * extension opening a full-screen view (doc, DM conversation) claims
 * with a namespaced owner string, renders (clearLog + its content),
 * and every other extension checks the owner before painting into the
 * log. /back (communities) releases ANY owner; onChange fires so the
 * default timeline repaints and the leaving owner drops its handles.
 */
export interface ViewBus {
  owner(): string;
  claim(owner: string): void;
  release(): void;
  onChange(cb: (owner: string) => void): void;
}

const viewChangeCbs: ((owner: string) => void)[] = [];
let viewOwner = "channel";
const viewBus: ViewBus = {
  owner: () => viewOwner,
  claim(owner: string) {
    if (viewOwner === owner) return;
    viewOwner = owner;
    for (const cb of viewChangeCbs) {
      try {
        cb(owner);
      } catch { /* one broken view must not break the rest */ }
    }
  },
  release() {
    viewBus.claim("channel");
  },
  onChange(cb) {
    viewChangeCbs.push(cb);
  },
};

export type InputHandler = (text: string) => Promise<boolean>;

export type UrlHandler = (url: string) => void;

/**
 * A theme pack's payload — a named Partial of fez-tui's FezTheme,
 * declared structurally here so packs (which can't resolve fez-tui from
 * ~/.fez/extensions) and core agree on shape without a shared import.
 * Style functions are (s) => s-with-ANSI; packs use raw escape codes
 * (chalk doesn't resolve from the extensions dir either — see
 * examples/themes/). Unknown tokens are ignored; omitted ones fall back
 * to the default theme.
 */
export interface ThemeSpec {
  name: string;
  you?: (s: string) => string;
  brand?: (s: string) => string;
  authorPalette?: ((s: string) => string)[];
  timestamp?: (s: string) => string;
  dim?: (s: string) => string;
  accent?: (s: string) => string;
  error?: (s: string) => string;
  banner?: (s: string) => string;
  sidebarBg?: (s: string) => string;
  userMessageBg?: (s: string) => string;
  loader?: { spinner?: (s: string) => string; message?: (s: string) => string };
  markdown?: Record<string, (...args: string[]) => string>;
  editor?: Record<string, unknown>;
}

const themeRegistry = new Map<string, ThemeSpec>();

export function registerTheme(spec: ThemeSpec): void {
  if (!spec?.name) {
    console.error("⚠️  registerTheme: theme has no name — skipped");
    return;
  }
  themeRegistry.set(spec.name, spec);
}

export function getRegisteredThemes(): ThemeSpec[] {
  return [...themeRegistry.values()];
}

export function findTheme(name: string): ThemeSpec | undefined {
  return themeRegistry.get(name);
}

export interface FezExtensionAPI {
  registerHarness(adapter: HarnessAdapter): void;
  registerMcpServer(name: string, server: McpServer): void;
  registerCommand(name: string, handler: CommandHandler): void;
  registerInputHandler(handler: InputHandler): void;
  /**
   * Claim clicks on OSC-8 hyperlinks whose URL starts with `prefix` — the
   * mechanism behind clickable sidebar/chat text. Embed a link as
   * `\x1b]8;;URL\x1b\\label\x1b]8;;\x1b\\`; when the user clicks it, the
   * first matching handler runs. Unclaimed http(s) URLs open in the
   * system browser.
   */
  registerUrlHandler(prefix: string, handler: UrlHandler): void;
  /**
   * Register a theme pack (see ThemeSpec). Registering doesn't activate —
   * the user picks with /theme <name>, persisted across sessions.
   */
  registerTheme(spec: ThemeSpec): void;
  /**
   * Background work: a task the ALWAYS-ON host (fez sentinel) runs on an
   * interval, independent of any UI. This is how an extension does
   * something on a schedule without shipping its own daemon — the
   * sentinel is already running, supervised, and holds the user's key.
   *
   * Hosts that aren't always-on (the TUI, one-shot CLI) ignore these:
   * a task must never be required for the extension's foreground
   * behavior. `everyMs` is floored at 60s by the host, and a throwing
   * task is logged and retried on the next tick, never fatal.
   */
  registerScheduledTask(name: string, everyMs: number, run: (ctx: ScheduledTaskContext) => Promise<void> | void): void;
  /**
   * Add standing instructions to every agent this host starts — a
   * compliance rule, a house style, a workflow's operating conditions.
   *
   * Contributed, never assigned: nobody owns the whole prompt, because
   * an extension that could replace it could also delete the trust
   * boundary that stops a channel message giving orders. Sections are
   * ordered (default 500; core reserves under 100) and re-registering
   * the same id replaces it, so a reload cannot duplicate a rule.
   */
  registerSystemPromptSection(section: { id: string; text: string | (() => string | undefined); order?: number }): void;
  /**
   * Durable state for THIS extension — a namespaced key-value file under
   * ~/.fez/extension-data/, dropped by `fez remove`. Always present, no
   * permission: the grant list is consent to things done TO the user,
   * and an extension keeping its own notes isn't one (a Node module
   * could write files regardless — see extension-permissions.ts on why
   * we don't imply a sandbox that doesn't exist).
   */
  storage: StorageAccess;
  nostr?: NostrAccess;
  /**
   * Open channels and post in them, without knowing the wire.
   *
   * The same seam a scheduled task gets, available wherever `nostr` is —
   * because a COMMAND is how a person asks for a channel, and a bridge
   * that could only act on a timer would be a strange thing to build.
   * Undefined outside the TUI/sentinel, exactly like `nostr`.
   *
   * The owner is the workspace's, not the caller's: only the owner may
   * sign a channel into being, so ensure() returns undefined for anyone
   * else rather than publishing an event the relay will refuse.
   *
   * Undefined when the workspace owner is not known — an unclaimed relay,
   * or one whose NIP-11 could not be read. There is deliberately no
   * fallback to the local key: assuming you own a relay you merely
   * connected to made `list()` silently empty and `ensure()` publish
   * events the relay would refuse, with nothing in either path saying why.
   */
  channels?: ChannelsAccess;
  /**
   * Which relay this is and who owns it — see WorkspaceAccess.
   *
   * Undefined outside the TUI/sentinel, like `nostr`.
   */
  workspace?: WorkspaceAccess;
  /**
   * The process's ONE shared @fezchat/client instance — protocol state,
   * trust rules, and actions, headless. Extensions render views over it
   * instead of each re-deriving state from raw subscriptions. Undefined
   * outside the TUI. Extensions type it structurally (or via a type-only
   * import of @fezchat/client, erased at bundle time).
   */
  client?: FezClient;
  ui: {
    setStatus(key: string, value: string): void;
    createSidePanel(opts?: { width?: number; title?: string; icon?: string; order?: number }): PanelHandle;
    appendMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
    /** Insert a bubble ABOVE the existing timeline — older-page history loading. */
    prependMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
    /** Fires when the user parks the chat log at its very top with content overflowing — the scroll-up "load older" trigger. The viewport is held in place across whatever the handler prepends. */
    onLogScrollTop(handler: () => Promise<void>): void;
    /** Dim system one-liner — notices, not chat: no author bubble, no timestamp, clearly not a participant. */
    notify(text: string): void;
    /** Wipe the chat log — view switching (e.g. a thread view repainting the timeline). */
    clearLog(): void;
    /** Cross-extension view ownership — see ViewBus. */
    viewBus: ViewBus;
  };
}

/** What a scheduled task gets: the relay, the owner's identity, and honesty about the clock. */
export interface ScheduledTaskContext {
  nostr: NostrAccess;
  /** The machine owner's pubkey — the authority a task acts on behalf of. */
  ownerPubkey: string;
  /**
   * Open channels and post in them, without knowing the wire.
   *
   * A bridge's whole job is "mirror this thing into a channel", and
   * before this it had to copy kind numbers and threading tags out of
   * src/kinds.ts to do it — which fez-github did, and was the only
   * package in the repo doing. Signed by the same key the task already
   * had; the owner-only rule on creating a channel is unchanged.
   */
  channels: ChannelsAccess;
  /**
   * True when this tick follows a gap much longer than the interval (the
   * machine slept). Tasks should catch up ONCE, never replay the backlog.
   */
  missedWindow: boolean;
}

export interface ScheduledTask {
  name: string;
  everyMs: number;
  run: (ctx: ScheduledTaskContext) => Promise<void> | void;
}

const scheduledTasks: ScheduledTask[] = [];
/** Drained by the sentinel after loadExtensions(); empty everywhere else. */
export function registeredScheduledTasks(): readonly ScheduledTask[] {
  return scheduledTasks;
}

export type FezExtension = (api: FezExtensionAPI) => void | Promise<void>;

// ─── Backends, installed by tui.ts before loadExtensions(). Absent (CLI
// subcommands), nostr stays undefined and the UI surface degrades to inert
// no-ops so extensions can load without crashing. ─────────────────────────

interface UiBackend {
  createSidePanel(opts?: { width?: number; title?: string; icon?: string; order?: number }): PanelHandle;
  appendMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
  prependMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
  onLogScrollTop(handler: () => Promise<void>): void;
  notify(text: string): void;
  clearLog(): void;
}

const inertMessageHandle: MessageHandle = {
  setAuthor: () => {},
  setContent: () => {},
  setFooter: () => {},
  setMeta: () => {},
};

let nostrBackend: NostrAccess | undefined;
let clientBackend: FezClient | undefined;

export function setClientBackend(client: FezClient): void {
  clientBackend = client;
}
let uiBackend: UiBackend | undefined;
const inputHandlers: InputHandler[] = [];
const urlHandlers: { prefix: string; handler: UrlHandler }[] = [];

export function setNostrBackend(backend: NostrAccess): void {
  nostrBackend = backend;
}

let workspaceBackend: WorkspaceAccess | undefined;

/**
 * Tell extensions which workspace this process is on.
 *
 * Both key-holding hosts must call this: the TUI has the owner in its
 * client state, but the sentinel has no client at all, and before this it
 * fell through to "the local key must be the owner" — so a sentinel on
 * someone else's relay silently believed it owned the place.
 */
export function setWorkspaceBackend(workspace: WorkspaceAccess): void {
  workspaceBackend = workspace;
}

export function setUiBackend(backend: UiBackend): void {
  uiBackend = backend;
}

export function getInputHandlers(): readonly InputHandler[] {
  return inputHandlers;
}

/** First registered handler whose prefix matches wins; undefined if none. */
export function findUrlHandler(url: string): UrlHandler | undefined {
  return urlHandlers.find((h) => url.startsWith(h.prefix))?.handler;
}

/**
 * Build the API an extension actually receives. Capabilities it wasn't
 * granted are REPLACED with no-ops that say so once — an extension that
 * quietly does nothing is worse to debug than one that logs why.
 */
export function buildApi(granted: readonly string[], extensionName = "extension"): FezExtensionAPI {
  const refuse = (permission: string, what: string) => {
    let warned = false;
    return () => {
      if (!warned) {
        warned = true;
        console.warn(`⚠️  extension tried to ${what} without the "${permission}" permission — ignored`);
      }
    };
  };
  const may = (permission: string) => granted.includes(permission);

  /**
   * Who owns this workspace, per the relay's own NIP-11 document — never
   * the local key. Undefined is a real answer (unclaimed relay), and the
   * seams that need an owner go undefined with it rather than guessing.
   *
   * Resolved on every ACCESS, not once when the api is built. Extensions
   * are constructed during startup, deliberately BEFORE the client
   * connects (they have to be listening when its first events land), so
   * at build time nobody knows the owner yet — a snapshot here is always
   * undefined and would disable the channels seam permanently. It also
   * has to survive the user switching relays, which changes the answer.
   */
  const workspaceOwner = () => clientBackend?.state.workspace.owner ?? workspaceBackend?.owner;

  // The nostr surface is the sharp one: read is the channel firehose,
  // publish signs AS THE USER. Gate them separately.
  // Whitelist EVERY member explicitly — never spread nostrBackend. A spread
  // exposes any method not overridden here RAW, which is exactly how
  // signEvent/encrypt/decrypt used to leak past the permission gates (an
  // extension with no grant could sign as the user or decrypt private
  // content). Listing each member means a newly-added backend method is
  // unreachable until it's deliberately gated here.
  const bk = nostrBackend;
  // `publish` already implies the ability to sign (you can't publish an
  // event without signing it), so it satisfies the sign gate too.
  const canSign = () => may("sign") || may("publish");
  const gatedNostr: NostrAccess | undefined = bk && {
    pubkey: bk.pubkey, // public — safe to expose ungated
    publish: may("publish")
      ? bk.publish
      : (async (tmpl) => {
          refuse("publish", "publish an event")();
          return { ...tmpl, id: "", pubkey: "", created_at: 0, sig: "" } as never;
        }),
    signEvent: canSign()
      ? bk.signEvent
      : ((tmpl) => {
          refuse("sign", "sign an event")();
          return { ...tmpl, id: "", pubkey: "", created_at: tmpl.created_at ?? 0, sig: "" } as never;
        }),
    encrypt: canSign()
      ? bk.encrypt
      : ((_peer, _text) => { refuse("sign", "encrypt with your key")(); return ""; }),
    // Decrypt reads private content addressed to you — `read:dms` covers the
    // inbox case, `sign` the general crypto case. Throw (not "") so a denied
    // call can't masquerade as valid empty plaintext; decrypt already throws
    // on bad input, so callers cope with a throw.
    decrypt: (may("sign") || may("read:dms"))
      ? bk.decrypt
      : ((_peer, _cipher) => {
          refuse("sign", "decrypt with your key")();
          throw new Error('extension denied: needs "sign" or "read:dms" to decrypt');
        }),
    sendDm: may("publish") ? bk.sendDm : (async () => { refuse("publish", "send a DM")(); return ""; }),
    query: may("read:channels") ? bk.query : (async () => { refuse("read:channels", "query the relay")(); return []; }),
    subscribe: may("read:channels")
      ? bk.subscribe
      : (() => { refuse("read:channels", "subscribe to the relay")(); return () => {}; }),
    unwrapDm: may("read:dms") ? bk.unwrapDm : (() => { refuse("read:dms", "read a DM")(); return undefined; }),
  };

  return {
    registerHarness,
    registerMcpServer,
    registerCommand: may("commands") ? registerCommand : (refuse("commands", "register a slash command") as never),
    registerInputHandler: (handler) => { if (may("commands")) inputHandlers.push(handler); else refuse("commands", "claim chat input")(); },
    registerUrlHandler: (prefix, handler) => { if (may("ui")) urlHandlers.push({ prefix, handler }); else refuse("ui", "claim url clicks")(); },
    registerTheme: may("ui") ? registerTheme : (refuse("ui", "register a theme") as never),
    registerScheduledTask: (name, everyMs, run) => {
      if (!may("background")) return refuse("background", "register a scheduled task")();
      scheduledTasks.push({ name, everyMs, run });
    },
    // Ids are namespaced by extension so two packages can both register
    // a "rules" section without one silently replacing the other.
    registerSystemPromptSection: may("system-prompt")
      ? (section) => registerSystemPromptSection({ ...section, id: `${extensionName}:${section.id}` })
      : () => console.warn(`⚠️  extension "${extensionName}" tried to add system-prompt rules without the "system-prompt" permission — ignored`),
    storage: makeStorage(extensionName),
    nostr: gatedNostr,
    // Getters, for the reason on workspaceOwner: an extension is built
    // before the client connects, so anything resolved here and now is
    // resolved too early. The client's live view wins (the TUI learns the
    // owner from NIP-11 at connect), then whatever the host declared (the
    // sentinel). No owner means no channels seam — see `channels` above.
    get channels(): ChannelsAccess | undefined {
      const owner = workspaceOwner();
      return gatedNostr && owner ? makeChannels(gatedNostr, owner) : undefined;
    },
    get workspace(): WorkspaceAccess | undefined {
      const owner = workspaceOwner();
      if (!workspaceBackend && owner === undefined) return undefined;
      return { relayUrl: workspaceBackend?.relayUrl, owner, info: workspaceBackend?.info };
    },
    client: may("read:channels") ? clientBackend : undefined,
    ui: {
      setStatus,
      createSidePanel: (opts) =>
        uiBackend ? uiBackend.createSidePanel(opts) : { setText: () => {} },
      appendMessage: (author, content, ts, opts) =>
        uiBackend ? uiBackend.appendMessage(author, content, ts, opts) : inertMessageHandle,
      prependMessage: (author, content, ts, opts) =>
        uiBackend ? uiBackend.prependMessage(author, content, ts, opts) : inertMessageHandle,
      onLogScrollTop: (handler) => uiBackend?.onLogScrollTop(handler),
      notify: (text) => uiBackend?.notify(text),
      clearLog: () => uiBackend?.clearLog(),
      viewBus,
    },
  };
}

const EXTENSIONS_DIR = fezHome("extensions");

/**
 * Loads every extension in `dir` (default `~/.fez/extensions/`), the same
 * discovery pattern pi uses for `~/.pi/agent/extensions/`. Each file's
 * default export is called with the live FezExtensionAPI.
 *
 * .js/.mjs files always load. .ts files only load when the current process
 * has a TypeScript loader already active (e.g. running via `tsx`) — plain
 * `node dist/cli.js` cannot execute them natively. That's a real limitation,
 * not hidden: a failed import is reported per-file, not swallowed, and
 * loading continues with the remaining files either way.
 */
export async function loadExtensions(
  dir: string = EXTENSIONS_DIR,
  /**
   * Load ONLY these extension basenames. The sentinel passes its
   * background allowlist: an extension written for the TUI would
   * otherwise start doing its foreground job a second time inside the
   * always-on process (duplicate notifications, duplicate summons).
   */
  only?: readonly string[]
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // no extensions directory yet — nothing to load
  }

  // Bundles are ESM in .js files; without a package.json in the dir,
  // Node walks UP the tree for one, so a stray CJS package.json in any
  // ancestor (home dir, /tmp) silently flips every extension to CJS and
  // they all fail with "Cannot use import statement". Pin the type here
  // rather than depend on the filesystem above us.
  const marker = path.join(dir, "package.json");
  try {
    await fs.access(marker);
  } catch {
    await fs.writeFile(marker, JSON.stringify({ type: "module" }, null, 1), "utf-8").catch(() => {});
  }

  const { loadSettings } = await import("../shared/settings.js");
  const grants = (loadSettings() as { extensionPermissions?: Record<string, string[]> }).extensionPermissions ?? {};

  for (const entry of entries) {
    if (!/\.(ts|js|mjs)$/.test(entry)) continue;
    const name = entry.replace(/\.(ts|js|mjs)$/, "");
    if (only && !only.includes(name)) continue;
    // Each extension gets its OWN api object, narrowed to what it was
    // granted — a shared api would hand every extension everything.
    const api = buildApi(grants[name] ?? LEGACY_GRANT, name);
    const filePath = path.join(dir, entry);

    try {
      const mod = await import(pathToFileURL(filePath).href);
      const extension: FezExtension | undefined = mod.default;
      if (typeof extension !== "function") {
        console.error(`⚠️  ${entry} has no default export function — skipped`);
        continue;
      }
      await extension(api);
    } catch (err) {
      console.error(
        `⚠️  Failed to load extension ${entry}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
