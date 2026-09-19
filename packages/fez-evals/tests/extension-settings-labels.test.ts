// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import SettingsPane from "../../fez-desktop/src/SettingsPane.js";
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
  const names = ["wallet", "fez-github", "fez-browser", "mesh"];
  const renders = names.map(name => vi.fn(() => React.createElement("div", { "data-panel": name }, `${name} controls`)));
  names.forEach((name, i) => registerSettingsPanel(name, renders[i], name === "mesh" ? { label: "Shared Models" } : undefined));

  await act(async () => root.render(React.createElement(SettingsPane, { client, wire: {} as BrowserWire, onClose: () => {} })));
  const nav = [...document.querySelectorAll<HTMLButtonElement>(".settings-nav-item")];
  expect(nav.slice(-4).map(button => button.textContent)).toEqual(["wallet", "github", "browser", "Shared Models"]);
  expect(extensionSettingsPanels().map(panel => panel.name)).toEqual(names);

  await act(async () => nav.find(button => button.textContent === "github")!.click());
  expect(document.querySelector(".set-title")?.textContent).toBe("github");
  expect(document.querySelector(".settings-nav-item.active")?.textContent).toBe("github");
  expect(document.querySelector("[data-panel]")?.getAttribute("data-panel")).toBe("fez-github");
  expect(renders[1]).toHaveBeenCalled();
  expect(renders[0]).not.toHaveBeenCalled();
  expect(renders[2]).not.toHaveBeenCalled();

  await act(async () => nav.find(button => button.textContent === "Shared Models")!.click());
  expect(document.querySelector(".set-title")?.textContent).toBe("Shared Models");
  expect(document.querySelector("[data-panel]")?.getAttribute("data-panel")).toBe("mesh");
  expect(document.querySelector(".settings-nav-item.active")?.getAttribute("title")).toBe("mesh");
});
