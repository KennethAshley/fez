import type { Page } from "@playwright/test";

/** Browser stand-in for native child creation/IPC. The production launcher,
 * host handler, client snapshot and child runtime all run unchanged. Native
 * origin, storage and permission isolation remain covered by the WK probe. */
export async function installCustomPanelBridge(page: Page, extensions: Record<string, { code: string; grants: string[]; styles?: string }>) {
  // Run after the page's main-window init scripts and before the real child
  // module. New iframe documents can otherwise inherit the generic mock.
  const childSetup = () => {
    const label = new URL(location.href).searchParams.get("custom-fixture")!;
    const request = Reflect.get(window.parent, "customPanelRequest") as (label: string, request: unknown) => Promise<unknown>;
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: unknown }) => {
      if (command !== "isolated_panel_request") throw Error("Direct native commands are unavailable in the child fixture");
      return request(label, args.request);
    } } });
    document.documentElement.dataset.embedded = "true";
  };
  await page.route("**/__custom_panel_fixture.js", route => route.fulfill({ contentType: "text/javascript", body: `(${childSetup.toString()})();` }));
  await page.route("**/isolated-panel.html?custom-fixture=*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<script type="module"', '<script src="/__custom_panel_fixture.js"></script><script type="module"') });
  });
  await page.addInitScript(({ extensions }) => {
    type Request = { op: string; action?: string; args?: Record<string, unknown>; key?: string; shortcut?: string };
    type Bounds = { x: number; y: number; width: number; height: number };
    type Opening = { name: string; custom: Record<string, unknown>; hostRequests: { onmessage(id: number): void }; bounds: Bounds; appearance: string };
    type Pending = { label: string; operation: unknown; resolve(value: unknown): void; reject(error: Error): void };
    type Session = { opening: Opening; frame: HTMLIFrameElement };
    type Internal = { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
    if (window !== window.top) return;
    const install = () => {
      const internal = Reflect.get(window, "__TAURI_INTERNALS__") as Internal;
      const original = internal.invoke.bind(internal);
      const sessions = new Map<string, Session>(), pending = new Map<number, Pending>();
      let next = 0;
      const probe = { openings: [] as Record<string, unknown>[], requests: [] as Record<string, unknown>[], closed: [] as string[] };
      const presentation = (frame: HTMLIFrameElement, bounds: Bounds, visible = true) => {
        const style = `position:fixed;left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px;border:0;display:${visible ? "block" : "none"}`;
        if (frame.getAttribute("style") !== style) frame.setAttribute("style", style);
      };
      const request = async (label: string, request: Request) => {
        const session = sessions.get(label);
        if (!session) throw Error("Custom fixture view closed");
        const { name, custom } = session.opening, extension = extensions[name];
        probe.requests.push({ name, surface: custom, ...request });
        if (request.op === "bootstrap") return { name, code: extension.code, styles: extension.styles ?? "", client: extension.grants.includes("read:channels"), agents: null, custom };
        if (request.op === "get_preference" || (request.op === "custom" && request.action === "storage_get")) {
          const state = JSON.parse(String(await original("extension_storage_read", { name })));
          return { value: request.op === "get_preference" ? state.prefs?.[String(request.key)] : state[String(request.args?.key)] };
        }
        const operation = request.op === "custom" ? { ...request, name, grants: extension.grants }
          : request.op === "host_shortcut" ? request : undefined;
        if (!operation) throw Error(`Unexpected custom fixture request: ${request.op}`);
        return new Promise((resolve, reject) => {
          const id = ++next;
          pending.set(id, { label, operation, resolve, reject });
          session.opening.hostRequests.onmessage(id);
        });
      };
      Object.assign(window, { customPanelProbe: probe, customPanelRequest: request });
      internal.invoke = async (command, args = {}) => {
        if (command === "open_isolated_panel") {
          const opening = args as unknown as Opening;
          if (!extensions[opening.name] || !opening.custom) throw Error("Undeclared custom fixture");
          const label = `custom-fixture-${++next}`, frame = document.createElement("iframe");
          frame.setAttribute("data-custom-kind", String(opening.custom.kind));
          frame.setAttribute("data-custom-name", opening.name);
          if (opening.custom.tab) frame.setAttribute("data-custom-tab", String(opening.custom.tab));
          frame.title = `${opening.name} ${opening.custom.kind}`;
          const { x, y, width, height } = opening.bounds;
          const slot = document.elementFromPoint(x + width / 2, y + height / 2)?.closest(".isolated-custom-panel");
          if (!slot) throw Error("Missing custom launcher slot");
          presentation(frame, opening.bounds);
          sessions.set(label, { opening, frame });
          probe.openings.push({ label, name: opening.name, custom: opening.custom });
          frame.src = `/isolated-panel.html?custom-fixture=${label}`;
          slot.appendChild(frame);
          return label;
        }
        if (command === "update_isolated_panel") {
          const session = sessions.get(String(args.label));
          if (!session) throw Error("Custom fixture view closed");
          presentation(session.frame, args.bounds as Bounds, Boolean(args.visible));
          if (args.pageChanged) session.frame.contentWindow?.dispatchEvent(new Event("fez-custom-changed"));
          if (args.focus) session.frame.contentWindow?.focus();
          return null;
        }
        if (command === "close_isolated_panel") {
          const label = String(args.label), session = sessions.get(label);
          if (session) {
            session.frame.contentWindow?.dispatchEvent(new Event("pagehide"));
            session.frame.remove(); sessions.delete(label); probe.closed.push(label);
            for (const [id, value] of pending) if (value.label === label) { pending.delete(id); value.reject(Error("Custom fixture view closed")); }
          }
          return null;
        }
        if (command === "isolated_panel_host_request" || command === "isolated_panel_validate_request") {
          const value = pending.get(Number(args.id));
          if (!value || !sessions.has(value.label)) throw Error("Expired custom fixture request");
          return command === "isolated_panel_host_request" ? value.operation : null;
        }
        if (command === "isolated_panel_reply") {
          const value = pending.get(Number(args.id));
          if (!value) throw Error("Expired custom fixture reply");
          pending.delete(Number(args.id));
          const result = args.result as { Ok?: unknown; Err?: string };
          if (result.Err) value.reject(Error(result.Err)); else value.resolve(result.Ok);
          return null;
        }
        return original(command, args);
      };
    };
    Object.assign(window, { installCustomPanelFixture: install });
  }, { extensions });
  // Install in main after its other native fixture wrappers and boot complete.
  return () => page.evaluate(() => Reflect.get(window, "installCustomPanelFixture")());
}
