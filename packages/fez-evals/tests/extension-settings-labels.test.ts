// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import SettingsPane from "../../fez-desktop/src/SettingsPane.js";
import { IsolatedPanelLauncher } from "../../fez-desktop/src/IsolatedPanelLauncher.js";
import { extensionSettingsPanels, registerSettingsPanel } from "../../fez-desktop/src/gui-extensions.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";

const client = new FezClient({ pubkey: "owner" } as Wire);
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("shows friendly settings labels while selecting the original registered panel", async () => {
  const names = ["wallet", "fez-github", "fez-browser"];
  const renders = names.map(name => vi.fn(() => React.createElement("div", { "data-panel": name }, `${name} controls`)));
  names.forEach((name, i) => registerSettingsPanel(name, renders[i]));

  await act(async () => root.render(React.createElement(SettingsPane, { client, wire: {} as BrowserWire, onClose: () => {} })));
  const nav = [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-item")];
  expect(nav.slice(-3).map(button => button.textContent)).toEqual(["wallet", "github", "browser"]);
  expect(extensionSettingsPanels().map(panel => panel.name)).toEqual(names);

  await act(async () => nav.find(button => button.textContent === "github")!.click());
  expect(document.querySelector(".set-title")?.textContent).toBe("github");
  expect(document.querySelector(".settings-nav-item.active")?.textContent).toBe("github");
  expect(document.querySelector("[data-panel]")?.getAttribute("data-panel")).toBe("fez-github");
  expect(renders[1]).toHaveBeenCalled();
  expect(renders[0]).not.toHaveBeenCalled();
  expect(renders[2]).not.toHaveBeenCalled();
});

it("shows a friendly launcher label and sends the original name to the native panel", async () => {
  const invoke = vi.fn(async () => undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: () => 1 });
  await act(async () => root.render(React.createElement(IsolatedPanelLauncher, { name: "fez-browser", client })));
  const button = document.querySelector("button")!;
  expect(button.textContent).toBe("Open browser settings");

  await act(async () => button.click());
  expect(invoke).toHaveBeenCalledWith("open_isolated_panel", expect.objectContaining({ name: "fez-browser", agents: [] }), undefined);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
