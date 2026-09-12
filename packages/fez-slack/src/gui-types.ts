/** Type-only subset; the desktop provides the one shared React instance. */
export interface GuiExtensionAPI {
  React: {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
    useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  };
  client?: {
    agents(): Map<string, string>;
    listChannels(): Promise<{ id: string; name: string; archived?: boolean }[]>;
    extensionConfig<T>(extension: string): Promise<T | undefined>;
    saveExtensionConfig(extension: string, config: unknown): Promise<void>;
  };
  secrets: { set(key: string, value: string): Promise<void>; has(key: string): Promise<boolean> };
  registerSettingsPanel(name: string, render: () => unknown, opts?: { source?: string }): void;
}
