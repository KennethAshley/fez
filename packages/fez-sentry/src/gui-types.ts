export type El = unknown;
export interface GuiExtensionAPI {
  React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): El;
    useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  };
  client?: {
    agents(): Map<string, string>;
    listChannels(): Promise<{ id: string; name: string; archived?: boolean }[]>;
    extensionConfig<T>(extension: string): Promise<T | undefined>;
    saveExtensionConfig(extension: string, config: unknown): Promise<void>;
  };
  secrets: { set(key: string, value: string): Promise<void>; has(key: string): Promise<boolean> };
  fetch: typeof globalThis.fetch;
  registerSettingsPanel(name: string, render: () => El, opts?: { source?: string }): void;
}
