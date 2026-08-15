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

export interface FezExtensionAPI {
  registerHarness(adapter: HarnessAdapter): void;
  registerMcpServer(name: string, server: McpServer): void;
  registerCommand(name: string, handler: CommandHandler): void;
  registerInputHandler(handler: InputHandler): void;
  nostr?: NostrAccess;
  ui: {
    setStatus(key: string, value: string): void;
    createSidePanel(opts?: { width?: number }): PanelHandle;
    appendMessage(author: string, content: string): MessageHandle;
    /** Wipe the chat log — view switching (e.g. a thread view repainting the timeline). */
    clearLog(): void;
  };
}

export type FezExtension = (api: FezExtensionAPI) => void | Promise<void>;

// ─── Backends, installed by tui.ts before loadExtensions(). Absent (CLI
// subcommands), nostr stays undefined and the UI surface degrades to inert
// no-ops so extensions can load without crashing. ─────────────────────────

interface UiBackend {
  createSidePanel(opts?: { width?: number }): PanelHandle;
  appendMessage(author: string, content: string): MessageHandle;
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

export function setNostrBackend(backend: NostrAccess): void {
  nostrBackend = backend;
}

export function setUiBackend(backend: UiBackend): void {
  uiBackend = backend;
}

export function getInputHandlers(): readonly InputHandler[] {
  return inputHandlers;
}

function buildApi(): FezExtensionAPI {
  return {
    registerHarness,
    registerMcpServer,
    registerCommand,
    registerInputHandler: (handler) => inputHandlers.push(handler),
    nostr: nostrBackend,
    ui: {
      setStatus,
      createSidePanel: (opts) =>
        uiBackend ? uiBackend.createSidePanel(opts) : { setText: () => {} },
      appendMessage: (author, content) =>
        uiBackend ? uiBackend.appendMessage(author, content) : inertMessageHandle,
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
