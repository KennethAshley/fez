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

export interface GuiExtensionApi {
  React: {
    createElement(type: unknown, props?: Props, ...children: unknown[]): El;
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  };
  /** The shared @fezchat/client instance — read state, publish as the user. Withheld without `read:channels`. */
  client: GuiClient;
  /** Open a browser to `url`. */
  openUrl(url: string): Promise<void>;
  /** A card in Settings that configures this extension. `opts.source` ties it to a channel source for the rail. */
  registerSettingsPanel(name: string, render: () => El, opts?: { source?: string }): void;
  /** A slash command in the desktop composer. */
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
  /** Decorate chat messages whose content matches — a card under the bubble. */
  registerMessageDecorator?(
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => El
  ): void;
  /** A lens over a whole THREAD, keyed off its root message's content — rendered above the replies. */
  registerThreadView?(
    name: string,
    match: (rootContent: string) => boolean,
    render: (props: { channelId: string; rootId: string; rootContent: string }) => El
  ): void;
  /** Open the live activity ("watch") pane for an agent by name. */
  watchAgent?(name: string): void;
  /** Open a thread in the current channel view. */
  openThread?(channelId: string, rootId: string): void;
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
  /** NIP-98 header for one request — the key stays behind the seam. */
  httpAuthHeader(url: string, method: string): string | undefined;
  displayName(pk: string): string;
  workingAgents(): ReadonlyMap<string, { activity: string; ts: number }>;
  messages(channelId: string): readonly { id: string; content: string; rootId?: string }[];
  threadReplies(channelId: string, rootId: string): { id: string; content: string }[];
}
