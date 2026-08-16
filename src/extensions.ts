import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { Event, Filter } from "nostr-tools";
import { registerHarness, type HarnessAdapter } from "./harness.js";
import { registerMcpServer } from "./mcp-servers.js";
import { registerCommand, type CommandHandler } from "./commands.js";
import { setStatus } from "./status.js";

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
  subscribe(filters: Filter[], onEvent: (event: Event) => void): () => void;
  query(filters: Filter[]): Promise<Event[]>;
  /** NIP-44 with the user's key — private pipes over public relays (observer frames, DMs). */
  encrypt(peerPubkey: string, plaintext: string): string;
  /** Throws on wrong key/garbage — callers decide whether that's ignorable. */
  decrypt(peerPubkey: string, ciphertext: string): string;
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
}

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
  nostr?: NostrAccess;
  ui: {
    setStatus(key: string, value: string): void;
    createSidePanel(opts?: { width?: number; title?: string; icon?: string }): PanelHandle;
    appendMessage(author: string, content: string): MessageHandle;
    /** Dim system one-liner — notices, not chat: no author bubble, no timestamp, clearly not a participant. */
    notify(text: string): void;
    /** Wipe the chat log — view switching (e.g. a thread view repainting the timeline). */
    clearLog(): void;
  };
}

export type FezExtension = (api: FezExtensionAPI) => void | Promise<void>;

// ─── Backends, installed by tui.ts before loadExtensions(). Absent (CLI
// subcommands), nostr stays undefined and the UI surface degrades to inert
// no-ops so extensions can load without crashing. ─────────────────────────

interface UiBackend {
  createSidePanel(opts?: { width?: number; title?: string; icon?: string }): PanelHandle;
  appendMessage(author: string, content: string): MessageHandle;
  notify(text: string): void;
  clearLog(): void;
}

const inertMessageHandle: MessageHandle = {
  setAuthor: () => {},
  setContent: () => {},
  setFooter: () => {},
};

let nostrBackend: NostrAccess | undefined;
let uiBackend: UiBackend | undefined;
const inputHandlers: InputHandler[] = [];
const urlHandlers: { prefix: string; handler: UrlHandler }[] = [];

export function setNostrBackend(backend: NostrAccess): void {
  nostrBackend = backend;
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

function buildApi(): FezExtensionAPI {
  return {
    registerHarness,
    registerMcpServer,
    registerCommand,
    registerInputHandler: (handler) => inputHandlers.push(handler),
    registerUrlHandler: (prefix, handler) => urlHandlers.push({ prefix, handler }),
    registerTheme,
    nostr: nostrBackend,
    ui: {
      setStatus,
      createSidePanel: (opts) =>
        uiBackend ? uiBackend.createSidePanel(opts) : { setText: () => {} },
      appendMessage: (author, content) =>
        uiBackend ? uiBackend.appendMessage(author, content) : inertMessageHandle,
      notify: (text) => uiBackend?.notify(text),
      clearLog: () => uiBackend?.clearLog(),
    },
  };
}

const EXTENSIONS_DIR = path.join(os.homedir(), ".fez", "extensions");

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
export async function loadExtensions(dir: string = EXTENSIONS_DIR): Promise<void> {
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

  const api = buildApi();

  for (const entry of entries) {
    if (!/\.(ts|js|mjs)$/.test(entry)) continue;
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
