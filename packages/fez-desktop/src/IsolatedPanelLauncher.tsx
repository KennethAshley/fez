import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient } from "@fezchat/client";
import { createGuiClient } from "./gui-client";
import { norm } from "./extensions-catalog";
import type { PageViewProps } from "./gui-extensions";
import { createPageHost, type PageOperation } from "./isolated-page-host";
import { createCustomHost, type CustomOperation } from "./isolated-custom-host";
import type { CustomSurface } from "../../../src/extensions/gui-custom-contributions";
import { openChannelAt, openThreadAt, openGuestDm } from "./gui-extensions";

type HostOperation =
  | CustomOperation
  | PageOperation
  | { op: "host_shortcut"; shortcut: "escape" | "palette" | "settings" | "focus_previous" | "focus_next" }
  | { op: "list_channels" }
  | { op: "create_channel"; name: string }
  | { op: "get_config"; scope: string }
  | { op: "set_config"; scope: string; value: unknown }
  | { op: "has_secret"; scope: string; key: string }
  | { op: "set_secret"; scope: string; key: string; value: string }
  | { op: "open_url"; url: string };

/** Native child Tab events need an explicit destination in the host's DOM. */
export function focusBesidePanel(panel: HTMLElement, previous: boolean): void {
  const controls = [...document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex],[contenteditable="true"]')]
    .filter(node => !panel.contains(node) && node.tabIndex >= 0 && !node.matches(":disabled") && !node.closest("[hidden],[inert]") && node.getClientRects().length);
  const adjacent = controls.filter(node => !!(panel.compareDocumentPosition(node) & (previous ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING)));
  const target = previous ? adjacent.at(-1) ?? controls.at(-1) : adjacent[0] ?? controls[0];
  target?.focus();
}

// Called only by the native channel bound when this main-window launcher opens.
// Rust supplies the scope and checks the live grant before delivering a request.
export async function handlePanelRequest(client: FezClient, id: number, onShortcut?: (shortcut: Extract<HostOperation, { op: "host_shortcut" }>["shortcut"]) => void, pageHost?: ReturnType<typeof createPageHost>, customHost?: ReturnType<typeof createCustomHost>): Promise<void> {
  let result: { Ok: unknown } | { Err: string };
  try {
    const request = await invoke<HostOperation>("isolated_panel_host_request", { id });
    switch (request.op) {
      case "custom":
        if (!customHost) throw Error("This panel has no custom surface");
        result = { Ok: await customHost(request, () => invoke("isolated_panel_validate_request", { id })) };
        break;
      case "read_page": case "save_page": case "comment_page":
        if (!pageHost) throw Error("This panel has no document");
        result = { Ok: await pageHost(request, () => invoke("isolated_panel_validate_request", { id })) };
        if (request.op === "read_page" && result.Ok && typeof result.Ok === "object") {
          result = { Ok: { ...result.Ok, agents: request.can_read_agents ? [...client.agents()].slice(0, 1000) : null } };
        }
        break;
      case "host_shortcut":
        if (!onShortcut) throw new Error("Panel keyboard navigation unavailable");
        onShortcut(request.shortcut); result = { Ok: null }; break;
      case "list_channels": result = { Ok: await createGuiClient(client, "isolated-panel", ["read:channels"]).listChannels() }; break;
      case "create_channel": result = { Ok: await createGuiClient(client, "isolated-panel", ["read:channels", "publish"]).createChannel(request.name) }; break;
      case "get_config": result = { Ok: { value: await client.extensionConfig(request.scope) } }; break;
      case "set_config": await client.saveExtensionConfig(request.scope, request.value); result = { Ok: null }; break;
      case "has_secret": result = { Ok: await invoke<boolean>("has_skill_secret", { skill: request.scope, key: request.key }) }; break;
      case "set_secret": await invoke("set_skill_secret", { skill: request.scope, key: request.key, value: request.value }); result = { Ok: null }; break;
      case "open_url": await openUrl(request.url); result = { Ok: null }; break;
      default: throw new Error("Unsupported panel host operation");
    }
  } catch (error) { result = { Err: String(error) }; }
  // Closing or timing out the panel can invalidate an otherwise completed reply.
  await invoke("isolated_panel_reply", { id, result }).catch(() => {});
}

export function IsolatedPanelLauncher({ name, client, page, pageView, custom, customOpenTab }: { name: string; client: FezClient; page?: PageViewProps; pageView?: string; custom?: CustomSurface; customOpenTab?: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const currentPage = useRef(page);
  currentPage.current = page;
  const currentCustom = useRef(custom);
  currentCustom.current = custom;
  const currentOpenTab = useRef(customOpenTab);
  currentOpenTab.current = customOpenTab;
  const customKey = custom ? JSON.stringify(custom) : undefined;
  const notifyPage = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const element = container.current!;
    let disposed = false;
    let label: string | undefined;
    let frame = 0;
    let pageChanged = false;
    setError("");
    setLoading(true);
    const presentation = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(document.documentElement);
      const tokens = ["--bg0", "--bg1", "--bg2", "--fg", "--fg-dim", "--accent", "--hairline", "--font-ui", "--font-mono", "--green", "--red", "--yellow"];
      const appearance = tokens.map(key => `${key}:${style.getPropertyValue(key)};`).join("") + `color-scheme:${style.colorScheme};`;
      // Native views sit above the DOM. Hide when a host dialog covers the
      // slot, so quit prompts and other overlays stay visible and clickable.
      const visible = width > 0 && height > 0 && [[x + 1, y + 1], [x + width / 2, y + height / 2], [x + width - 1, y + height - 1]]
        .every(([left, top]) => element.contains(document.elementFromPoint(left, top)));
      return { bounds: { x, y, width, height }, appearance, visible };
    };
    const fail = (error: unknown) => {
      if (label) { void invoke("close_isolated_panel", { label }).catch(console.error); label = undefined; }
      if (!disposed) { setError(String(error)); setLoading(false); }
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (label && !disposed) {
          const changed = pageChanged; pageChanged = false;
          void invoke("update_isolated_panel", { label, ...presentation(), pageChanged: changed }).catch(fail);
        }
      });
    };
    notifyPage.current = () => { pageChanged = true; update(); };
    let agentSnapshot = JSON.stringify([...client.agents()]);
    const offAgents = pageView ? client.on("presenceChanged", () => {
      const next = JSON.stringify([...client.agents()]);
      if (next !== agentSnapshot) { agentSnapshot = next; notifyPage.current(); }
    }) : undefined;
    const offCustom = customKey ? (["channelsChanged", "presenceChanged", "paymentReceipt", "reaction", "messageEdited", "messageDeleted"] as const)
      .map(event => client.on(event, () => { pageChanged = true; update(); })) : [];
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const mutations = new MutationObserver(update);
    mutations.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const focus = () => { if (label) void invoke("update_isolated_panel", { label, ...presentation(), focus: true }).catch(fail); };
    element.addEventListener("focus", focus);
    const pageHost = createPageHost(() => disposed ? undefined : currentPage.current);
    const customHost = createCustomHost(client, () => disposed ? undefined : currentCustom.current, {
      openChannel: openChannelAt, openThread: openThreadAt, openGuestDm,
      openTab: id => currentOpenTab.current?.(id),
    });
    const hostRequests = new Channel<number>(id => { void handlePanelRequest(client, id, shortcut => {
      if (disposed || !presentation().visible) return;
      if (shortcut === "focus_previous" || shortcut === "focus_next") {
        focusBesidePanel(element, shortcut === "focus_previous");
        return;
      }
      if (shortcut === "escape" && element.closest(".ext-modal")) {
        element.closest(".ext-modal")?.querySelector<HTMLButtonElement>(".pane-close")?.click();
        return;
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: shortcut === "escape" ? "Escape" : shortcut === "palette" ? "k" : ",", metaKey: shortcut !== "escape", bubbles: true, cancelable: true }));
    }, pageHost, customHost); });
    void invoke<string>("open_isolated_panel", { name, agents: [...client.agents()], hostRequests, pageView, custom: currentCustom.current, relayUrls: client.workspaces().map(workspace => workspace.relay), ...presentation() }).then(async opened => {
      if (disposed) { await invoke("close_isolated_panel", { label: opened }); return; }
      label = opened;
      setLoading(false);
      update();
    }).catch(fail);
    return () => {
      disposed = true;
      offAgents?.();
      offCustom.forEach(off => off());
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      element.removeEventListener("focus", focus);
      if (label) void invoke("close_isolated_panel", { label }).catch(console.error);
    };
  }, [name, client, attempt, pageView, customKey]);
  useEffect(() => { notifyPage.current(); }, [page?.content, page?.versionId, page?.editable, page?.title]);
  return <div ref={container} tabIndex={0} className={`isolated-settings-panel${pageView ? " isolated-page-panel" : ""}${custom ? ` isolated-custom-panel${custom.kind === "navSummary" ? " isolated-custom-summary" : ""}` : ""}`} aria-label={pageView ? `${norm(name)} document view` : custom ? `${norm(name)} view` : `${norm(name)} settings`}>
    {loading && <p role="status">{pageView ? "Loading document view…" : custom ? "Loading extension…" : "Loading settings…"}</p>}
    {error && <><p role="alert">{error}</p><button className="agent-action" onClick={() => setAttempt(value => value + 1)}>Retry</button></>}
  </div>;
}
