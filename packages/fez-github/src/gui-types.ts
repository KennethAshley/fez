/**
 * Structural mirror of fez-desktop's GuiExtensionAPI — the slice this
 * extension uses. Type-only, erased at bundle time.
 */
export type El = unknown;
export type Props = Record<string, unknown> | null;

export interface GuiExtensionAPI {
  React: {
    createElement(type: unknown, props?: Props, ...children: unknown[]): El;
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
    useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
    useCallback<T>(fn: T, deps?: unknown[]): T;
  };
  client: {
    pubkey: string;
    extensionConfig<T>(extension: string): Promise<T | undefined>;
    saveExtensionConfig(extension: string, config: unknown): Promise<void>;
  };
  /** Write-only, namespaced to this extension. There is no get(). */
  secrets: { set(key: string, value: string): Promise<void>; has(key: string): Promise<boolean> };
  openUrl(url: string): Promise<void>;
  registerSettingsPanel(name: string, render: () => El): void;
}
