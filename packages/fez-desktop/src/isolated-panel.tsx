import * as React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { MountPoint } from "./MountPoint";
import type { MountRender } from "./mount-result";
import type { GuiExtensionApi } from "./gui-extensions";

// Explicitly partial: each added capability requires a native broker operation.
export type IsolatedPanelApi = Pick<GuiExtensionApi, "React" | "prefs" | "secrets" | "openUrl" | "fetch" | "registerSettingsPanel"> & {
  client?: Pick<NonNullable<GuiExtensionApi["client"]>, "agents" | "extensionConfig" | "saveExtensionConfig" | "listChannels" | "createChannel">;
};
type BrokerRequest =
  | { op: "list_channels" }
  | { op: "create_channel"; name: string }
  | { op: "bootstrap" }
  | { op: "get_preference"; key: string }
  | { op: "set_preference"; key: string; value: unknown }
  | { op: "get_config"; extension: string }
  | { op: "set_config"; extension: string; value: unknown }
  | { op: "has_secret"; key: string }
  | { op: "set_secret"; key: string; value: string }
  | { op: "open_url"; url: string }
  | { op: "http_request"; url: string; method: string; headers: [string, string][]; body: string | null };
interface Bootstrap { name: string; code: string; styles: string; client: boolean; agents: [string, string][] | null }
const request = <T,>(request: BrokerRequest) => invoke<T>("isolated_panel_request", { request });

class PanelBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return { error: String(error) }; }
  render() { return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children; }
}

const root = createRoot(document.getElementById("root")!);
let closed = false;
window.addEventListener("pagehide", () => { closed = true; root.unmount(); }, { once: true });
root.render(<p>Loading extension settings…</p>);

async function load() {
  const bootstrap = await request<Bootstrap>({ op: "bootstrap" });
  if (closed) return;
  document.title = `${bootstrap.name} settings · Fez`;
  let render: MountRender | undefined;
  const agents = bootstrap.agents;
  const api: IsolatedPanelApi = {
    React,
    client: bootstrap.client ? {
      listChannels: () => request({ op: "list_channels" }),
      createChannel: name => request({ op: "create_channel", name }),
      agents: () => { if (agents === null) throw new Error("extension requires read:agents permission"); return new Map(agents); },
      extensionConfig: async <T,>(extension: string) => (await request<{ value?: T }>({ op: "get_config", extension })).value,
      saveExtensionConfig: async (extension, value) => { await request({ op: "set_config", extension, value }); },
    } : undefined,
    secrets: {
      has: key => request<boolean>({ op: "has_secret", key }),
      set: async (key, value) => { await request({ op: "set_secret", key, value }); },
    },
    openUrl: async url => { await request({ op: "open_url", url }); },
    fetch: async (input, init) => {
      const req = new Request(input, init);
      req.signal.throwIfAborted();
      const reply = await request<{ status: number; headers: [string, string][]; body: string; url: string }>({
        op: "http_request", url: req.url, method: req.method,
        headers: [...req.headers], body: req.body === null ? null : await req.text(),
      });
      req.signal.throwIfAborted();
      const response = new Response(req.method === "HEAD" || [204, 205, 304].includes(reply.status) ? null : reply.body, { status: reply.status, headers: reply.headers });
      Object.defineProperty(response, "url", { value: reply.url });
      return response;
    },
    prefs: {
      get: async <T,>(key: string) => (await request<{ value?: T }>({ op: "get_preference", key })).value,
      set: async (key, value) => { await request({ op: "set_preference", key, value }); },
    },
    registerSettingsPanel: (_label, callback) => {
      if (render) throw new Error("An isolated GUI part can register one settings panel");
      render = callback;
    },
  };
  // Existing IIFE bundles execute here, never in the main app's JS realm.
  const mod: unknown = new Function(`${bootstrap.code}\n;return __fezExt;`)();
  if (!mod || typeof mod !== "object") throw new Error("Invalid GUI bundle");
  const activate: unknown = Reflect.get(mod, "default") ?? Reflect.get(mod, "activate");
  if (typeof activate !== "function") throw new Error("GUI bundle has no activate function");
  await activate(api);
  if (closed) return;
  if (!render) throw new Error("Extension did not register a settings panel");
  if (bootstrap.styles) {
    const style = document.createElement("style");
    style.textContent = bootstrap.styles;
    document.head.appendChild(style);
  }
  root.render(<PanelBoundary><h1>{bootstrap.name} settings</h1><MountPoint render={render} /></PanelBoundary>);
}
void load().catch((error: unknown) => { if (!closed) root.render(<p role="alert">{String(error)}</p>); });
