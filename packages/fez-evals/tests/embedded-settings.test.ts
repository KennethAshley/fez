// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import { IsolatedPanelLauncher, focusBesidePanel } from "../../fez-desktop/src/IsolatedPanelLauncher.js";

const client = new FezClient({ pubkey: "owner" } as Wire);
let root: ReturnType<typeof createRoot>;
const invoke = vi.fn();
let resize: () => void;
let covered = false;
const render = () => act(async () => root.render(React.createElement(IsolatedPanelLauncher, { name: "fez-github", client })));
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  covered = false;
  invoke.mockReset().mockImplementation(async command => command === "open_isolated_panel" ? "extension-panel-1" : null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: (command: string, args: unknown) => invoke(command, args), transformCallback: () => 1 });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 260, y: 180, left: 260, top: 180, right: 960, bottom: 680, width: 700, height: 500, toJSON() {} });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => covered ? document.body : document.querySelector(".isolated-settings-panel") });
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("Tab leaves custom panels in both directions without focusing their own launcher", () => {
  const area = document.createElement("section");
  area.innerHTML = '<button id="before">Channel tab</button><div tabindex="0" id="panel"><button>Native placeholder</button></div><button hidden>Hidden</button><button disabled>Disabled</button><button id="after">Close pane</button>';
  document.body.append(area);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  const panel = area.querySelector<HTMLElement>("#panel")!;
  focusBesidePanel(panel, true);
  expect(document.activeElement?.id).toBe("before");
  focusBesidePanel(panel, false);
  expect(document.activeElement?.id).toBe("after");
  area.remove();
});

it("opens inside the allocated settings area automatically, resizes, and closes on leaving settings", async () => {
  await render();
  await flush();
  expect(invoke).toHaveBeenCalledWith("open_isolated_panel", expect.objectContaining({ name: "fez-github", bounds: { x: 260, y: 180, width: 700, height: 500 } }));
  expect(document.body.textContent).not.toContain("separate window");
  expect(document.querySelector(".isolated-settings-panel")?.getAttribute("aria-label")).toBe("github settings");
  await act(async () => resize());
  await flush();
  expect(invoke).toHaveBeenCalledWith("update_isolated_panel", expect.objectContaining({ label: "extension-panel-1", visible: true }));
  await act(async () => document.querySelector<HTMLElement>(".isolated-settings-panel")!.focus());
  expect(invoke).toHaveBeenLastCalledWith("update_isolated_panel", expect.objectContaining({ focus: true }));
  await act(async () => root.render(null));
  expect(invoke).toHaveBeenCalledWith("close_isolated_panel", { label: "extension-panel-1" });
});

it("hides the native view under host dialogs and restores it when the dialog closes", async () => {
  await render();
  await flush();
  covered = true;
  await act(async () => { document.body.appendChild(document.createElement("dialog")); });
  await flush();
  expect(invoke).toHaveBeenLastCalledWith("update_isolated_panel", expect.objectContaining({ visible: false }));
  covered = false;
  await act(async () => { document.querySelector("dialog")!.remove(); });
  await flush();
  expect(invoke).toHaveBeenLastCalledWith("update_isolated_panel", expect.objectContaining({ visible: true }));
});

it("closes a slow opening panel after unmount and reports opening failures with retry", async () => {
  let finish!: (label: string) => void;
  invoke.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  await render();
  await act(async () => root.render(null));
  await act(async () => finish("extension-panel-late"));
  expect(invoke).toHaveBeenCalledWith("close_isolated_panel", { label: "extension-panel-late" });
  invoke.mockRejectedValueOnce(new Error("ui permission revoked"));
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("ui permission revoked");
  const retry = document.querySelector("button")!;
  await act(async () => retry.click());
  await flush();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
