/**
 * The GUI surface — the API a `gui` part receives, running in the
 * desktop webview. The host injects React (`api.React`) so the page
 * keeps ONE React, and every capability is gated by a permission the
 * install dialog names.
 *
 * `El` is a React element the host renders; you build it with
 * `api.React.createElement` (aliased `h`), not JSX, so your bundle
 * carries no React of its own.
 */
export type El = unknown;
export type Props = Record<string, unknown> | null;

export interface RepoChannelLike {
  id: string;
  name: string;
  meta?: Record<string, string>;
}

/** A fez artifact, as the gui seams pass it around. */
export interface ArtifactLike {
  id: string;
  channelId: string;
  authorPk: string;
  authorName: string;
  type: string;
  title?: string;
  content: string;
  ts: number;
  rootId?: string;
}

/** Props a page view receives — a whole document (wiki page or channel doc). */
export interface PageViewProps {
  content: string;
  save: (next: string) => Promise<void>;
  comment: (text: string, anchor: string, mentions: string[]) => Promise<void>;
  title: string;
  channelId: string;
  /** wiki page slug, absent for a channel doc */
  slug?: string;
  /** false when an old version is on screen — a view must not rewrite history */
  editable: boolean;
}

/** Props a fenced-block renderer receives — the block, and where it lives. */
export interface BlockProps {
  /** everything after the language tag on the fence line */
  info: string;
  /** the block's body text */
  body: string;
  /** the whole fenced block verbatim — the anchor for a comment on it */
  raw: string;
  channelId: string;
  /** wiki page slug, absent for a channel doc */
  slug?: string;
}

export interface GuiExtensionApi {
  React: {
    createElement(type: unknown, props?: Props, ...children: unknown[]): El;
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
    useRef<T>(initial: T): { current: T };
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  };
  /** The shared @fezchat/client instance — read state, publish as the user. Withheld without `read:channels`. */
  client: GuiClient;
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
  /** Open a browser to `url`. */
  openUrl(url: string): Promise<void>;
  /** A card in Settings that configures this extension. `opts.source` ties it to a channel source for the rail. */
  registerSettingsPanel(name: string, render: () => El, opts?: { source?: string }): void;
  /** A slash command in the desktop composer. */
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
  /** Decorate chat messages whose content matches — a card under the bubble. */
  registerMessageDecorator(
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => El
  ): void;
  /** A lens over a whole THREAD, keyed off its root message's content — rendered above the replies. */
  registerThreadView(
    name: string,
    match: (rootContent: string) => boolean,
    render: (props: { channelId: string; rootId: string; rootContent: string }) => El
  ): void;
  /**
   * Own a whole document view: when `match(content)` is true (or "default"
   * to claim any doc), your component renders instead of the plain editor.
   */
  registerPageView(name: string, match: (content: string) => boolean | "default", render: (props: PageViewProps) => El): void;
  /**
   * Own a fenced block by its language tag: ```<lang> … ``` renders with
   * your component. `menu` adds a slash-menu entry that inserts the block.
   */
  registerBlockRenderer(lang: string, render: (props: BlockProps) => El, menu?: object): void;
  /** Open the live activity ("watch") pane for an agent by name. */
  watchAgent(name: string): void;
  /** Open a thread in the current channel view. */
  openThread(channelId: string, rootId: string): void;
  /**
   * A top-level view in the rail, beside inbox and docs — for a feature
   * that is a PLACE (loom's ▣ tools gallery, a board). The host owns the
   * button and the main-column shell; you own everything inside.
   */
  registerNavView(name: string, opts: { glyph: string; label: string }, render: () => El): void;
  /**
   * An action mounted in an open artifact pane's header, next to ✕. Your
   * component receives the artifact and owns its own state.
   */
  registerArtifactAction(name: string, render: (props: { artifact: ArtifactLike }) => El): void;
  /** Open an artifact in the tool pane — the same pane a thread's tool handle opens. */
  openTool(artifact: ArtifactLike): void;
  /**
   * Write a scaffolded extension package to ~/fez-tools/<slug> — the
   * host-side, path-bounded export. You supply file contents; where they
   * land is not negotiable from here.
   */
  exportTool(files: { slug: string; guiJs: string; pkgJson: string; readme: string }): Promise<string>;
  /**
   * Read and edit agent personas — sensitive (`personas` permission),
   * because a persona is an agent's programming. Absent when ungranted.
   */
  personas?: {
    list(): Promise<string[]>;
    read(name: string): Promise<string>;
    update(name: string, content: string): Promise<void>;
    create(name: string, content: string): Promise<void>;
    /** Roster a local persona's stable key now, before it has ever run. */
    invite(name: string, role?: "bot" | "member"): Promise<"invited" | "no-key" | "unknown">;
  };
}

/**
 * The slice of @fezchat/client a GUI extension typically reaches. The real
 * client has far more; type against what you use.
 */
export interface GuiClient {
  pubkey: string;
  relayInfo(): (Record<string, unknown> & { pubkey?: string }) | undefined;
  channelsFrom(source: string): RepoChannelLike[];
  ensureChannel(spec: { name: string; source?: string; meta?: Record<string, string> }): Promise<string | undefined>;
  on(event: "channelsChanged", handler: () => void): () => void;
  sendChannelMessage(text: string, opts?: { channelId?: string }): Promise<unknown>;
  /** Channel docs the client has absorbed, by channel id. */
  docsByChannel(): ReadonlyMap<string, { latestContent?: string }>;
  /** Publish a new doc version into a channel. */
  publishDoc(channelId: string, content: string): Promise<void>;
  /** NIP-98 header for one request — the key stays behind the seam.
   * Async since key custody moved into the host process (the desktop
   * signs in Rust); always await it. */
  httpAuthHeader(url: string, method: string): Promise<string | undefined>;
  /** A pubkey's display name, hex-shortened when unknown. */
  displayName(pk: string): string;
  /** The pubkey behind an @name, if the client knows one. */
  pkByName(name: string): string | undefined;
  workingAgents(): ReadonlyMap<string, { activity: string; ts: number }>;
  messages(channelId: string): readonly { id: string; content: string; rootId?: string }[];
  threadReplies(channelId: string, rootId: string): { id: string; content: string }[];
}
