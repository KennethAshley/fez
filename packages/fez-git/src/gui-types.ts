/**
 * Structural mirror of fez-desktop's GuiExtensionApi — the slice this
 * extension uses. Type-only, erased at bundle time, the same
 * arrangement fez-github has and for the same reason: an installed
 * extension is one bundled file with no reachable node_modules.
 */
export type El = unknown;
export type Props = Record<string, unknown> | null;

export interface RepoChannel {
  id: string;
  name: string;
  meta?: Record<string, string>;
}

export interface GuiExtensionAPI {
  React: {
    createElement(type: unknown, props?: Props, ...children: unknown[]): El;
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  };
  client: {
    pubkey: string;
    /** The relay's NIP-11 document, including what its extensions advertised. */
    relayInfo(): (Record<string, unknown> & { pubkey?: string }) | undefined;
    /** Channels a given maker opened — how the rail groups them. */
    channelsFrom(source: string): RepoChannel[];
    /** Open or edit a channel. Undefined when this key may not sign one. */
    ensureChannel(spec: {
      name: string;
      source?: string;
      meta?: Record<string, string>;
    }): Promise<string | undefined>;
    on(event: "channelsChanged", handler: () => void): () => void;
    /** Post as the user — channelId addresses a channel without standing in it. */
    sendChannelMessage(text: string, opts?: { channelId?: string }): Promise<unknown>;
    /** Channel docs the client has absorbed, by channel id. */
    docsByChannel(): ReadonlyMap<string, { latestContent?: string }>;
    /** Publish a new doc version into a channel. */
    publishDoc(channelId: string, content: string): Promise<void>;
    /** NIP-98 header for one request — the key stays behind the seam. */
    httpAuthHeader(url: string, method: string): string | undefined;
    /** A pubkey's display name, hex-shortened when unknown. */
    displayName(pk: string): string;
    /** Agents currently mid-turn, by name. */
    workingAgents(): ReadonlyMap<string, { activity: string; ts: number }>;
    /** The channel's messages the client has absorbed (slice: id + content + threading). */
    messages(channelId: string): readonly { id: string; content: string; rootId?: string }[];
    /** Replies under one thread root. */
    threadReplies(channelId: string, rootId: string): { id: string; content: string }[];
  };
  openUrl(url: string): Promise<void>;
  /** Personas seam — absent when the "personas" permission wasn't granted. */
  personas?: {
    list(): Promise<string[]>;
    read(name: string): Promise<string>;
    update(name: string, content: string): Promise<void>;
    create(name: string, content: string): Promise<void>;
    invite(name: string, role?: "bot" | "member"): Promise<"invited" | "no-key" | "unknown">;
  };
  /** Decorate chat messages whose content matches. */
  registerMessageDecorator(
    match: (content: string) => boolean,
    render: (props: { content: string; msgId: string; channelId: string; authorName: string }) => El
  ): void;
  /** A lens on a whole thread, keyed off its root's content. */
  registerThreadView(
    name: string,
    match: (rootContent: string) => boolean,
    render: (props: { channelId: string; rootId: string; rootContent: string }) => El
  ): void;
  /** Open the live activity pane for an agent, by name. */
  watchAgent(name: string): void;
  /** Open a thread in the current channel view (no-op for other channels). */
  openThread(channelId: string, rootId: string): void;
  registerSettingsPanel(name: string, render: () => El, opts?: { source?: string }): void;
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
}
