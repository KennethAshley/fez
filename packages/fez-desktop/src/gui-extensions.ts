import React from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fez/client";
import { registerArtifactViewer } from "./artifact-viewers";

/**
 * The GUI extension loader — the desktop half of the multi-part package
 * contract. `fez install`/`fez link` drops a package's gui part into
 * ~/.fez/gui-extensions/<name>.js; at boot each file is imported as an
 * ES module (blob URL — same-origin, no server) and its default export
 * (or `activate`) is called with the GUI api. Extensions bundle their
 * own code but use api.React so there's exactly one React in the page.
 *
 * v1 surface: registerArtifactViewer (the "obsidian extensions" seam),
 * registerTheme (CSS-variable packs), and the headless client.
 */

export interface GuiExtensionApi {
  React: typeof React;
  client: FezClient;
  registerArtifactViewer: typeof registerArtifactViewer;
  registerTheme: (name: string, vars: Record<string, string>) => void;
  /** Decorate chat messages: when match(content) is true, render() is
   * mounted under the message body (how the polls card enters). */
  registerMessageDecorator: (
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; communityId: string; authorName: string }) => React.ReactNode
  ) => void;
  /** Add a slash command to the GUI composer (/name). */
  registerGuiCommand: (name: string, run: (args: string) => Promise<string> | string) => void;
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
  registerBlockRenderer: (lang: string, render: (props: BlockProps) => React.ReactNode) => void;
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
  communityId: string;
  /** wiki page slug, absent for a channel doc */
  slug?: string;
}

// ── decorator + command registries (host side of the seams) ────────
export interface MessageDecorator {
  match: (content: string) => boolean;
  render: (props: { content: string; msgId: string; channelId: string; communityId: string; authorName: string }) => React.ReactNode;
}
const decorators: MessageDecorator[] = [];
export function registerMessageDecorator(match: MessageDecorator["match"], render: MessageDecorator["render"]): void {
  decorators.push({ match, render });
}
export function messageDecorators(): readonly MessageDecorator[] {
  return decorators;
}

const guiCommands = new Map<string, (args: string) => Promise<string> | string>();
export function registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void {
  guiCommands.set(name.toLowerCase(), run);
}
export function guiCommand(name: string): ((args: string) => Promise<string> | string) | undefined {
  return guiCommands.get(name.toLowerCase());
}

// ── markdown extension registries (the doc-side seam) ──────────────
const markdownPlugins: unknown[] = [];
export function registerMarkdownPlugin(plugin: unknown): void {
  markdownPlugins.push(plugin);
}
export function docMarkdownPlugins(): readonly unknown[] {
  return markdownPlugins;
}

const blockRenderers = new Map<string, (props: BlockProps) => React.ReactNode>();
export function registerBlockRenderer(lang: string, render: (props: BlockProps) => React.ReactNode): void {
  blockRenderers.set(lang.toLowerCase(), render);
}
export function blockRenderer(lang: string): ((props: BlockProps) => React.ReactNode) | undefined {
  return blockRenderers.get(lang.toLowerCase());
}

// ── theme registry ─────────────────────────────────────────────────
const themes = new Map<string, Record<string, string>>();
const THEME_KEY = "fez-gui-theme";

export function registerTheme(name: string, vars: Record<string, string>): void {
  themes.set(name, vars);
  if (localStorage.getItem(THEME_KEY) === name) applyThemeVars(vars);
}

export function themeNames(): string[] {
  return [...themes.keys()].sort();
}

export function currentTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? "default";
}

export function applyTheme(name: string): void {
  localStorage.setItem(THEME_KEY, name);
  if (name === "default") {
    document.documentElement.removeAttribute("style");
    return;
  }
  const vars = themes.get(name);
  if (vars) applyThemeVars(vars);
}

function applyThemeVars(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith("--")) document.documentElement.style.setProperty(key, value);
  }
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

type Activate = (api: GuiExtensionApi) => void;

async function importModule(code: string): Promise<{ default?: Activate; activate?: Activate }> {
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
  const factory = new Function(`${code}\n;return (typeof __fezExt !== "undefined" ? __fezExt : undefined);`);
  const exported = factory() as { default?: Activate; activate?: Activate } | Activate | undefined;
  if (typeof exported === "function") return { default: exported };
  if (exported) return exported;
  throw new Error("neither an importable module nor an IIFE with global __fezExt");
}

export async function loadGuiExtensions(client: FezClient): Promise<string[]> {
  const loaded: string[] = [];
  status.length = 0;
  let files: [string, string][];
  try {
    files = await invoke<[string, string][]>("list_gui_extensions");
  } catch {
    return loaded;
  }
  const api: GuiExtensionApi = {
    React,
    client,
    registerArtifactViewer,
    registerTheme,
    registerMessageDecorator,
    registerGuiCommand,
    registerMarkdownPlugin,
    registerBlockRenderer,
  };
  for (const [name, code] of files) {
    try {
      const mod = await importModule(code);
      const activate = mod.default ?? mod.activate;
      if (typeof activate !== "function") throw new Error("no default export / activate()");
      activate(api);
      loaded.push(name);
      status.push({ name, ok: true });
      console.log(`🧩 gui extension loaded: ${name}`);
    } catch (err) {
      status.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
      console.error(`🧩 gui extension "${name}" failed to load:`, err);
    }
  }
  return loaded;
}
