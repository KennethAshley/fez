import * as React from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { CustomSurface } from "../../../src/extensions/gui-custom-contributions";
import type { CustomSnapshot } from "./isolated-custom-host";
import { classifyMountResult, type MountRender } from "./mount-result";
import type { IsolatedPanelApi } from "./isolated-panel";

type MessageProps = Extract<CustomSurface, { kind: "message" }>;
type ThreadProps = Extract<CustomSurface, { kind: "thread" }>;
type ProfileProps = Extract<CustomSurface, { kind: "profile" }>;
type RenderProps<P> = (props: P, host?: HTMLElement) => ReturnType<MountRender>;
type Nav = { render: MountRender; tabs?: { id: string; label: string; render: MountRender }[]; summary?: RenderProps<{ openTab: (id: string) => void }> };
const custom = <T,>(action: string, args: unknown = {}) => invoke<T>("isolated_panel_request", { request: { op: "custom", action, args } });

/** The compatibility adapter lives only in the isolated realm. No callback crosses IPC. */
export async function createCustomRuntime(base: IsolatedPanelApi, opening: CustomSurface) {
  let snapshot = await custom<CustomSnapshot>("snapshot");
  if (snapshot.surface.kind !== opening.kind) throw Error("Custom view selection changed");
  let closed = false;
  let refreshing: Promise<void> | undefined;
  let failure: string | undefined;
  let detail: { title: string; render: MountRender } | undefined;
  const changed = new Set<() => void>();
  const channelListeners = new Set<() => void>();
  const receiptListeners = new Set<(channelId: string, targetId: string) => void>();
  const navs = new Map<string, Nav>();
  const threads = new Map<string, { match: (content: string) => boolean; render: RenderProps<ThreadProps> }>();
  const messages: { match: (content: string) => boolean; render: RenderProps<MessageProps> }[] = [];
  const profiles: RenderProps<ProfileProps>[] = [];
  let settings: MountRender | undefined;
  const notify = () => { for (const listener of changed) listener(); };
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = custom<CustomSnapshot>("snapshot").then(next => {
      if (closed) return;
      const channelsChanged = JSON.stringify(snapshot.channels) !== JSON.stringify(next.channels);
      const receiptsChanged = JSON.stringify(snapshot.receipts) !== JSON.stringify(next.receipts);
      const different = JSON.stringify(snapshot) !== JSON.stringify(next);
      snapshot = next;
      if (channelsChanged) for (const listener of channelListeners) listener();
      if (receiptsChanged && next.surface.kind === "message") for (const listener of receiptListeners) listener(next.surface.channelId, next.surface.msgId);
      if (different || failure) { failure = undefined; notify(); }
    }).catch(error => { if (!closed) { failure = String(error); notify(); } throw error; }).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const mutate = async <T,>(action: string, args: unknown): Promise<T> => {
    const result = await custom<T>(action, args);
    // Mining checks channelsFrom immediately after ensureChannel returns.
    // Finish any older read, then obtain state after this mutation.
    await refreshing?.catch(() => {});
    await refresh();
    return result;
  };
  const report = (action: string, args: unknown) => { void custom(action, args).catch(error => { failure = String(error); notify(); }); };
  const api = {
    ...base,
    client: snapshot.grants.includes("read:channels") ? {
      ...base.client,
      get pubkey() { return snapshot.pubkey; },
      get state() { return { workspace: { owner: snapshot.owner } }; },
      relayInfo: () => ({ pubkey: snapshot.owner }),
      channelsFrom: (source?: string) => structuredClone(snapshot.channels.filter(channel => source === undefined || channel.source === source)),
      workspaces: () => structuredClone(snapshot.workspaces),
      listChannels: async () => structuredClone(snapshot.channels.filter(channel => !channel.archived)),
      displayName: (pk: string) => snapshot.names.find(([key]) => key === pk)?.[1] ?? pk.slice(0, 8),
      pkByName: (name: string) => snapshot.pubkeysByName.find(([key]) => key === name.toLowerCase())?.[1],
      agents: () => { if (!snapshot.agents) throw Error("Extension requires read:agents permission"); return new Map(snapshot.agents); },
      msgById: (id: string) => snapshot.message?.id === id ? structuredClone(snapshot.message) : undefined,
      myReactionTimeTo: (id: string, emoji: string) => snapshot.message?.id === id ? snapshot.reactions.find(([key]) => key === emoji)?.[1] : undefined,
      paymentReceiptsFor: (id: string) => snapshot.message?.id === id ? structuredClone(snapshot.receipts) : [],
      ensureChannel: (spec: { id?: string; name: string; source?: string; visibility?: "open" | "closed"; meta?: Record<string, string> }) => mutate<string | undefined>("ensure_channel", { spec }),
      toggleReaction: async (channelId: string, targetId: string, emoji: string) => { await mutate("toggle_reaction", { channelId, targetId, emoji }); },
      on: (event: "channelsChanged" | "paymentReceipt", listener: (() => void) | ((channelId: string, targetId: string) => void)) => {
        if (event === "channelsChanged") { const fn = listener as () => void; channelListeners.add(fn); return () => { channelListeners.delete(fn); }; }
        if (event === "paymentReceipt") { receiptListeners.add(listener); return () => { receiptListeners.delete(listener); }; }
        throw Error("Unsupported custom client subscription");
      },
    } : undefined,
    storage: { get: async <T,>(key: string) => (await custom<{ value?: T }>("storage_get", { key })).value },
    processes: snapshot.grants.includes("processes") ? {
      run: (bin: string, args: string[]) => custom<{ code: number; stdout: string; stderr: string }>("process_run", { bin, args }),
    } : undefined,
    agents: snapshot.grants.includes("processes") ? {
      spawn: (bin: string, options: { name: string; env?: Record<string, string> }) => custom<number>("agent_spawn", { bin, ...options }),
      stop: (name: string, bin?: string) => custom<boolean>("agent_stop", { name, bin }),
      isRunning: (name: string, bin?: string) => custom<boolean>("agent_alive", { name, bin }),
      lastExit: (name: string, bin: string) => custom<string | null>("agent_last_exit", { name, bin }),
    } : undefined,
    personas: snapshot.grants.includes("personas") ? {
      list: () => custom<string[]>("persona_list"),
      read: (name: string) => custom<string>("persona_read", { name }),
      update: async (name: string, content: string) => { await custom("persona_update", { name, content }); },
      create: async (name: string, content: string) => { await custom("persona_create", { name, content }); },
      invite: (name: string, role: "bot" | "member" = "bot") => mutate<"invited" | "no-key" | "unknown">("persona_invite", { name, role }),
    } : undefined,
    openChannel: (id: string) => report("open_channel", { id }),
    openThread: (channelId: string, rootId: string) => report("open_thread", { channelId, rootId }),
    openGuestDm: (guest: { pk: string; relay: string; name?: string; picture?: string; rateTaoHr?: number; draft?: string }) => report("open_guest_dm", { guest }),
    toast: (message: string, variant?: "success" | "error" | "warn" | "info") => report("toast", { message, variant }),
    notify: snapshot.grants.includes("notifications") ? (title: string, body: string, kind?: "agent_error" | "needs_action") => report("notify", { title, body, kind }) : undefined,
    openPanel: (title: string, render: MountRender) => { if (!closed) { detail = { title, render }; notify(); } },
    registerSettingsPanel: (_name: string, render: MountRender) => { if (settings) throw Error("Custom extension registered multiple settings panels"); settings = render; },
    registerNavView: (name: string, options: { glyph: string; label: string; channelWorkspace?: { tabs: Nav["tabs"]; summary?: Nav["summary"] } }, render: MountRender) => {
      if (navs.size >= 8) throw Error("Too many custom navigation views");
      navs.set(name, { render, tabs: options.channelWorkspace?.tabs, summary: options.channelWorkspace?.summary });
    },
    registerThreadView: (name: string, match: (content: string) => boolean, render: RenderProps<ThreadProps>) => {
      if (threads.size >= 8) throw Error("Too many custom thread views"); threads.set(name, { match, render });
    },
    registerMessageDecorator: (match: (content: string) => boolean, render: RenderProps<MessageProps>) => {
      if (messages.length >= 8) throw Error("Too many custom message views"); messages.push({ match, render });
    },
    registerAgentProfileSection: (_label: string, render: RenderProps<ProfileProps>) => {
      if (profiles.length >= 8) throw Error("Too many custom profile views"); profiles.push(render);
    },
  };
  const selected: MountRender = host => {
    const surface = snapshot.surface;
    switch (surface.kind) {
      case "settings": if (settings) return settings(host); break;
      case "nav": { const nav = navs.get(surface.name); if (nav) return nav.render(host); break; }
      case "navTab": { const tab = navs.get(surface.name)?.tabs?.find(tab => tab.id === surface.tab); if (tab) return tab.render(host); break; }
      case "navSummary": { const summary = navs.get(surface.name)?.summary; if (summary) return summary({ openTab: id => report("open_tab", { id }) }, host); break; }
      case "thread": { const thread = threads.get(surface.name); if (thread && thread.match(surface.rootContent)) return thread.render(surface, host); break; }
      case "message": {
        const message = messages[surface.index];
        if (message && message.match(surface.content)) return message.render(surface, host);
        break;
      }
      case "profile": { const profile = profiles[surface.index]; if (profile) return profile(surface, host); break; }
    }
    return <p role="status">This extension view is no longer available.</p>;
  };

  function LiveMount({ render }: { render: MountRender }) {
    const host = React.useRef<HTMLDivElement>(null);
    const [element, setElement] = React.useState<React.ReactNode>(null);
    React.useEffect(() => {
      const node = document.createElement("div"); node.style.display = "contents"; host.current!.appendChild(node);
      const result = classifyMountResult(render(node));
      setElement(result.element);
      // Updating the returned element preserves component state (wallet drafts,
      // confirmations and timers). Mount-form views own their subscriptions.
      const update = () => { if (!result.dispose) setElement(classifyMountResult(render(node)).element); };
      changed.add(update);
      return () => { changed.delete(update); queueMicrotask(() => { result.dispose?.(); node.remove(); }); };
    }, [render]);
    return <div ref={host} style={{ display: "contents" }}>{host.current && createPortal(element, host.current)}</div>;
  }
  function View() {
    const [, redraw] = React.useState(0);
    React.useEffect(() => { const update = () => redraw(value => value + 1); changed.add(update); return () => { changed.delete(update); }; }, []);
    return <>
      {failure && <p role="alert">{failure}</p>}
      <div hidden={!!detail}><LiveMount render={selected} /></div>
      {detail && <section><button onClick={() => { detail = undefined; notify(); }}>← Back</button><h2>{detail.title}</h2><LiveMount render={detail.render} /></section>}
    </>;
  }
  const onChange = () => { void refresh().catch(() => {}); };
  // Ordinary extension links share the same native grant check as api.openUrl.
  const onLink = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (event.defaultPrevented || !(link instanceof HTMLAnchorElement) || link.getAttribute("href")?.startsWith("#")) return;
    event.preventDefault();
    void (async () => {
      const url = new URL(link.href);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw Error("Unsupported extension link protocol");
      await base.openUrl(url.href);
    })().catch(error => { if (!closed) { failure = String(error); notify(); } });
  };
  const timer = window.setInterval(onChange, 3000);
  window.addEventListener("fez-custom-changed", onChange);
  document.addEventListener("click", onLink);
  return { api, View, refresh, dispose: () => {
    closed = true; clearInterval(timer); window.removeEventListener("fez-custom-changed", onChange);
    document.removeEventListener("click", onLink);
    changed.clear(); channelListeners.clear(); receiptListeners.clear();
  } };
}
