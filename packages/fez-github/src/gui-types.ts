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
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  };
  client: {
    pubkey: string;
    extensionConfig<T>(extension: string): Promise<T | undefined>;
    saveExtensionConfig(extension: string, config: unknown): Promise<void>;
  };
  /** Write-only, namespaced to this extension. There is no get(). */
  secrets: { set(key: string, value: string): Promise<void>; has(key: string): Promise<boolean> };
  openUrl(url: string): Promise<void>;
  /**
   * `source` names the channel source this panel configures, so the
   * rail's group for those channels can offer a settings button.
   */
  registerSettingsPanel(name: string, render: () => El, opts?: { source?: string }): void;
}
