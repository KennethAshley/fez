import * as React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { MountPoint } from "./MountPoint";
import type { MountRender } from "./mount-result";
import type { GuiExtensionApi, PageViewProps } from "./gui-extensions";
import type { PageSnapshot } from "./isolated-page-host";
import type { CustomSurface } from "../../../src/extensions/gui-custom-contributions";
import { createCustomRuntime } from "./isolated-custom";
import "./page-shell.css";
import "./fez-utilities.css";

// Explicitly partial: each added capability requires a native broker operation.
export type IsolatedPanelApi = Pick<GuiExtensionApi, "React" | "prefs" | "secrets" | "openUrl" | "fetch" | "registerSettingsPanel"> & {
  client?: Pick<NonNullable<GuiExtensionApi["client"]>, "agents" | "pkByName" | "extensionConfig" | "saveExtensionConfig" | "listChannels" | "createChannel">;
  showDetails(details: { title: string; body?: string; context?: string }): Promise<void>;
  confirm(details: { title: string; body?: string; context?: string }): Promise<boolean>;
};
type BrokerRequest =
  | { op: "show_details"; title: string; body: string | null; context: string | null }
  | { op: "confirm"; title: string; body: string | null; context: string | null }
  | { op: "resolve_details"; accepted: boolean }
  | { op: "close_details" }
  | { op: "read_page" }
  | { op: "save_page"; version: string; content: string }
  | { op: "comment_page"; version: string; text: string; anchor: string; mentions: string[] }
  | { op: "host_shortcut"; shortcut: "escape" | "palette" | "settings" | "focus_previous" | "focus_next" }
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
interface Bootstrap {
  name: string; code: string; styles: string; client: boolean; agents: [string, string][] | null; pageView?: string | null;
  details?: { title: string; body: string | null; context: string | null; confirmation?: boolean } | null;
  custom?: CustomSurface | null;
}
const request = <T,>(request: BrokerRequest) => invoke<T>("isolated_panel_request", { request });

// The native child has its own DOM, so these navigation keys do not reach
// the main app's listeners. Relay only this closed set through the broker.
window.addEventListener("keydown", event => {
  if (!document.documentElement.dataset.embedded || document.documentElement.dataset.surface === "details" || event.defaultPrevented) return;
  // Native dialogs and editing controls own their first Escape; the next one
  // may leave the page. Closing a card must not also close the host surface.
  if ((event.key === "Escape" || event.key === "Tab") && document.querySelector("dialog[open]")) return;
  let shortcut: Extract<BrokerRequest, { op: "host_shortcut" }>["shortcut"] | undefined;
  if (event.key === "Escape") shortcut = "escape";
  else if ((event.metaKey || event.ctrlKey) && event.key === "k") shortcut = "palette";
  else if ((event.metaKey || event.ctrlKey) && event.key === ",") shortcut = "settings";
  else if (event.key === "Tab") {
    const controls = [...document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length);
    if (event.shiftKey && document.activeElement === controls[0]) shortcut = "focus_previous";
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) shortcut = "focus_next";
  }
  if (shortcut) {
    event.preventDefault();
    void request({ op: "host_shortcut", shortcut }).catch(console.error);
  }
});

class PanelBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) { return { error: String(error) }; }
  render() { return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children; }
}

const root = createRoot(document.getElementById("root")!);
let closed = false;
let disposeCustom: (() => void) | undefined;
window.addEventListener("pagehide", () => { closed = true; disposeCustom?.(); root.unmount(); }, { once: true });
root.render(<p>Loading extension settings…</p>);

function DetailsDialog({ name, details, failure }: { name?: string; details: NonNullable<Bootstrap["details"]>; failure?: string }) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const initialFocus = React.useRef<HTMLButtonElement>(null);
  const closing = React.useRef(false);
  const [error, setError] = React.useState(failure ?? "");
  React.useEffect(() => { dialog.current?.showModal(); initialFocus.current?.focus(); }, []);
  const close = async (accepted?: boolean) => {
    if (closing.current) return;
    closing.current = true;
    try { await request(accepted === undefined ? { op: "close_details" } : { op: "resolve_details", accepted }); }
    catch (error) { if (!closed) setError(String(error)); }
    finally { closing.current = false; }
  };
  return <dialog ref={dialog} className="host-details-dialog" aria-labelledby="host-details-title"
    onCancel={event => { event.preventDefault(); void close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void close();
    }}>
    <header className="host-details-header"><span>{name ? `${name} · ${details.confirmation ? "Confirmation" : "Details"}` : "Details"}</span>{!details.confirmation && <button ref={initialFocus} type="button" autoFocus onClick={() => void close()}>Close</button>}</header>
    <div className="host-details-body">
      {details.context && <p className="host-details-context">{details.context}</p>}
      <h1 id="host-details-title">{details.title}</h1>
      {details.body && <div className="host-details-text">{details.body}</div>}
      {error && <p role="alert">{error}</p>}
    </div>
    {details.confirmation && <footer className="host-details-actions">
      <button ref={initialFocus} type="button" autoFocus onClick={() => void close(false)}>Cancel</button>
      <button type="button" onClick={() => void close(true)}>Confirm</button>
    </footer>}
  </dialog>;
}

function PageBody({ render, updateAgents }: { render: (props: PageViewProps) => React.ReactNode; updateAgents: (agents: PageSnapshot["agents"]) => void }) {
  const [page, setPage] = React.useState<PageSnapshot>();
  const [error, setError] = React.useState("");
  const sequence = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const id = ++sequence.current;
    try {
      const snapshot = await request<PageSnapshot>({ op: "read_page" });
      if (!closed && sequence.current === id) { updateAgents(snapshot.agents); setPage(snapshot); setError(""); }
    } catch (error) {
      if (!closed && sequence.current === id) { setPage(undefined); setError(String(error)); }
    }
  }, [updateAgents]);
  React.useEffect(() => {
    const changed = () => { void refresh(); };
    window.addEventListener("fez:page-changed", changed);
    void refresh();
    // This ref is a request counter, not a DOM node captured by the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { sequence.current++; window.removeEventListener("fez:page-changed", changed); };
  }, [refresh]);
  if (error) return <p role="alert">{error} <button onClick={() => void refresh()}>Retry</button></p>;
  if (!page) return <p role="status">Loading document…</p>;
  const write = async (operation: BrokerRequest) => {
    try { await request(operation); }
    finally { await refresh(); }
  };
  return render({ ...page,
    save: content => write({ op: "save_page", version: page.versionId ?? "", content }),
    comment: (text, anchor, mentions) => write({ op: "comment_page", version: page.versionId ?? "", text, anchor, mentions }),
  });
}

async function load() {
  const bootstrap = await request<Bootstrap>({ op: "bootstrap" });
  if (closed) return;
  if (bootstrap.details) {
    document.title = `${bootstrap.name} details · Fez`;
    document.documentElement.dataset.surface = "details";
    root.render(<PanelBoundary><DetailsDialog name={bootstrap.name} details={bootstrap.details} /></PanelBoundary>);
    return;
  }
  document.title = bootstrap.custom ? `${bootstrap.name} · Fez` : `${bootstrap.name} ${bootstrap.pageView ? "document" : "settings"} · Fez`;
  document.documentElement.dataset.surface = bootstrap.custom ? "custom" : bootstrap.pageView ? "page" : "settings";
  let render: MountRender | undefined;
  let renderPage: ((props: PageViewProps) => React.ReactNode) | undefined;
  let agents = bootstrap.agents;
  const updateAgents = (snapshot: PageSnapshot["agents"]) => { if (snapshot !== undefined) agents = snapshot; };
  const api: IsolatedPanelApi & { registerPageView: (name: string, match: unknown, render: (props: PageViewProps) => React.ReactNode) => void } = {
    React,
    showDetails: async ({ title, body, context }) => { await request({ op: "show_details", title, body: body ?? null, context: context ?? null }); },
    confirm: ({ title, body, context }) => request<boolean>({ op: "confirm", title, body: body ?? null, context: context ?? null }),
    client: bootstrap.client ? {
      listChannels: () => request({ op: "list_channels" }),
      createChannel: name => request({ op: "create_channel", name }),
      agents: () => { if (agents === null) throw new Error("extension requires read:agents permission"); return new Map(agents); },
      pkByName: name => agents?.find(([, candidate]) => candidate.toLowerCase() === name.toLowerCase())?.[0],
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
      if (bootstrap.pageView) throw Error("This host only accepts its declared page view");
      if (render) throw new Error("An isolated GUI part can register one settings panel");
      render = callback;
    },
    registerPageView: (name, _match, callback) => {
      if (name !== bootstrap.pageView || renderPage) throw Error("This host only accepts its declared page view");
      renderPage = callback;
    },
  };
  // Existing IIFE bundles execute here, never in the main app's JS realm.
  const mod: unknown = new Function(`${bootstrap.code}\n;return __fezExt;`)();
  if (!mod || typeof mod !== "object") throw new Error("Invalid GUI bundle");
  const activate: unknown = Reflect.get(mod, "default") ?? Reflect.get(mod, "activate");
  if (typeof activate !== "function") throw new Error("GUI bundle has no activate function");
  const custom = bootstrap.custom ? await createCustomRuntime(api, bootstrap.custom) : undefined;
  if (closed) { custom?.dispose(); return; }
  disposeCustom = custom?.dispose;
  await activate(custom?.api ?? api);
  if (closed) return;
  if (!custom && (bootstrap.pageView ? !renderPage : !render)) throw new Error("Extension did not register its declared surface");
  if (bootstrap.styles) {
    const style = document.createElement("style");
    style.textContent = bootstrap.styles;
    document.head.appendChild(style);
  }
  root.render(<PanelBoundary>{custom ? <custom.View /> : renderPage ? <PageBody render={renderPage} updateAgents={updateAgents} /> : <><h1>{bootstrap.name} settings</h1><MountPoint render={render!} /></>}</PanelBoundary>);
}
void load().catch((error: unknown) => {
  disposeCustom?.();
  const showError = () => {
    if (!closed) root.render(document.documentElement.dataset.surface === "details"
      ? <DetailsDialog details={{ title: "Details unavailable", body: null, context: null }} failure={String(error)} />
      : <p role="alert">{String(error)}</p>);
  };
  // A rejected IPC can precede the native DOMContentLoaded surface marker.
  if (document.readyState !== "complete") document.addEventListener("DOMContentLoaded", showError, { once: true });
  showError();
});
