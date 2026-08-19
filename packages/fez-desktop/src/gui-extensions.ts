import React from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fez/client";
import { registerArtifactViewer } from "./artifact-viewers";

/**
 * Mirrors src/extension-permissions.ts (the eval-pinned source of truth).
 * Inlined rather than imported: the desktop bundle deliberately does not
 * depend on the CLI package, and these are a few lines. If the rules
 * change there they change here — the eval gate covers the semantics.
 */
const LEGACY_GRANT = ["read:channels", "read:agents", "commands", "ui"];
function networkAllowed(hosts: readonly string[], url: string): boolean {
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
  /** A palette, or a { light, dark } pair that follows the OS. */
  registerTheme: (name: string, vars: ThemePack) => void;
  /** Decorate chat messages: when match(content) is true, render() is
   * mounted under the message body (how the polls card enters). */
  registerMessageDecorator: (
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => React.ReactNode
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
  registerBlockRenderer: (
    lang: string,
    render: (props: BlockProps) => React.ReactNode,
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
    render: (props: PageViewProps) => React.ReactNode
  ) => void;
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
  save: (next: string) => Promise<void>;
  comment: (text: string, anchor: string, mentions: string[]) => Promise<void>;
  title: string;
  channelId: string;
    slug?: string;
  /** false when an old version is on screen — views must not rewrite history */
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
const blockMenu: BlockMenuItem[] = [];
export function registerBlockRenderer(
  lang: string,
  render: (props: BlockProps) => React.ReactNode,
  menu?: BlockMenuItem
): void {
  blockRenderers.set(lang.toLowerCase(), render);
  if (menu) blockMenu.push(menu);
}
/** Extension-contributed `/` entries — a block installed is a block offered. */
export function extensionBlockMenu(): readonly BlockMenuItem[] {
  return blockMenu;
}
export function blockRenderer(lang: string): ((props: BlockProps) => React.ReactNode) | undefined {
  return blockRenderers.get(lang.toLowerCase());
}

export interface PageView {
  name: string;
  match: (content: string) => boolean | "default";
  render: (props: PageViewProps) => React.ReactNode;
}
const pageViews: PageView[] = [];
export function registerPageView(name: string, match: PageView["match"], render: PageView["render"]): void {
  pageViews.push({ name, match, render });
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
/**
 * The built-in palette, both ways up: gruvbox dark (what App.css has
 * always shipped, kept byte-identical so "default" looks unchanged) and
 * gruvbox light, its canonical counterpart.
 *
 * It lives here rather than in CSS because "default" now has to be
 * resolvable like any other theme — the same paint() picks the variant,
 * so following the OS is one code path instead of a special case.
 */
const BUILT_IN_DEFAULT = {
  dark: {
    "--bg0": "#1d2021",
    "--bg1": "#282828",
    "--bg2": "#3c3836",
    "--bg-mine": "#2d3a40",
    "--fg": "#ebdbb2",
    "--fg-dim": "#928374",
    "--accent": "#83a598",
    "--green": "#b8bb26",
    "--red": "#fb4934",
    "--yellow": "#fabd2f",
    "--brand": "#FF6A00",
  },
  light: {
    "--bg0": "#fbf1c7",
    "--bg1": "#f2e5bc",
    "--bg2": "#e0d5b0",
    // Your own messages: a cool tint, same role the dark side gives it.
    "--bg-mine": "#dbe4e6",
    "--fg": "#3c3836",
    "--fg-dim": "#7c6f64",
    // Gruvbox light's accents are darkened on purpose — the dark set's
    // pastels have nowhere near enough contrast on paper.
    "--accent": "#076678",
    "--green": "#79740e",
    "--red": "#9d0006",
    "--yellow": "#b57614",
    "--brand": "#d45500",
  },
};

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
  if (!pack) return;
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

type Activate = (api: GuiExtensionApi) => void;

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

export async function loadGuiExtensions(client: FezClient): Promise<string[]> {
  const loaded: string[] = [];
  status.length = 0;
  let files: [string, string][];
  try {
    files = await invoke<[string, string][]>("list_gui_extensions");
  } catch {
    return loaded;
  }
  let grants: Record<string, string[]> = {};
  try {
    grants = JSON.parse(await invoke<string>("read_extension_grants"));
  } catch { /* no grants recorded — everything falls back to the legacy grant */ }

  for (const [name, code] of files) {
    const granted = grants[name] ?? LEGACY_GRANT;
    const may = (permission: string) => granted.includes(permission);
    const hosts = granted.filter((g) => g.startsWith("network:")).map((g) => g.slice("network:".length));
    const refuse = (permission: string, what: string) => () =>
      console.warn(`⚠️  extension "${name}" tried to ${what} without "${permission}" — ignored`);
    const api: GuiExtensionApi = {
      React,
      // The client is the whole protocol surface (read AND publish), so
      // it is withheld entirely without read:channels; publish-less
      // extensions still get it, since narrowing every method is a bigger
      // change than this pass — flagged in the extensions view instead.
      client: may("read:channels") ? client : (undefined as never),
      registerArtifactViewer: may("ui") ? registerArtifactViewer : (refuse("ui", "register an artifact viewer") as never),
      registerTheme: may("ui") ? registerTheme : (refuse("ui", "register a theme") as never),
      registerMessageDecorator: may("ui") ? registerMessageDecorator : (refuse("ui", "decorate messages") as never),
      registerBlockRenderer: may("ui") ? registerBlockRenderer : (refuse("ui", "render doc blocks") as never),
      registerPageView: may("ui") ? registerPageView : (refuse("ui", "add a page view") as never),
      registerMarkdownPlugin: may("ui") ? registerMarkdownPlugin : (refuse("ui", "extend markdown") as never),
      registerGuiCommand: may("commands") ? registerGuiCommand : (refuse("commands", "add a slash command") as never),
    };
    try {
      const mod = await importModule(code, name, hosts);
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
