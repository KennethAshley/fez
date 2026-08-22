/**
 * Structural mirror of fez's FezExtensionAPI (src/extensions.ts) — the
 * slice this extension uses. Type-only, erased at bundle time; the
 * bundled file has zero imports. TypeScript's structural typing keeps
 * this honest against the real API.
 */

export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface PanelHandle {
  setText(text: string): void;
}

export interface MessageHandle {
  setAuthor(author: string): void;
  setContent(content: string): void;
  setFooter(text: string): void;
  setMeta(text: string): void;
}

export interface ViewBus {
  owner(): string;
  claim(owner: string): void;
  release(): void;
  onChange(cb: (owner: string) => void): void;
}

export interface CommandContext {
  reply(content: string): void;
}

export interface FezExtensionAPI {
  registerCommand(name: string, handler: (args: string, ctx: CommandContext) => void | Promise<void>): void;
  registerInputHandler(handler: (text: string) => Promise<boolean>): void;
  registerUrlHandler(prefix: string, handler: (url: string) => void): void;
  /** The process's shared @fezchat/client instance — typed via a type-only import of @fezchat/client. */
  client?: unknown;
  ui: {
    setStatus(key: string, value: string): void;
    createSidePanel(opts?: { width?: number; title?: string; icon?: string; order?: number }): PanelHandle;
    appendMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
    prependMessage(author: string, content: string, ts?: number, opts?: { linePrefix?: string; bare?: boolean }): MessageHandle;
    onLogScrollTop(handler: () => Promise<void>): void;
    notify(text: string): void;
    clearLog(): void;
    viewBus: ViewBus;
  };
}
