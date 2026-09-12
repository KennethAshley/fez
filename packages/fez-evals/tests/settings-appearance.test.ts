// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire } from "../../fez-client/src/index.js";
import SettingsPane from "../../fez-desktop/src/SettingsPane.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";
import { applyTheme, currentMode, currentTheme, registerSettingsPanel, registerTheme, startAppearanceWatch } from "../../fez-desktop/src/gui-extensions.js";

const client = new FezClient({ pubkey: "owner" } as Wire);
let root: ReturnType<typeof createRoot>;
const render = () => act(async () => root.render(React.createElement(SettingsPane, { client, wire: {} as BrowserWire, onClose: () => {} })));
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent)?.trim().toLowerCase() === name.toLowerCase())!;
const click = (name: string) => act(async () => button(name).click());
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  for (const key of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[key];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it("persists reading preferences across settings remounts, startup, and theme changes; reset leaves notifications alone", async () => {
  await render();
  await click("Appearance");
  expect(button("18 px")).toBeDefined();
  await click("18 px");
  await click("Compact");
  await click("Reduce motion");
  expect(document.documentElement.dataset.messageSize).toBe("18");
  expect(document.documentElement.dataset.messageSpacing).toBe("compact");
  expect(document.documentElement.dataset.reduceMotion).toBe("true");
  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  delete document.documentElement.dataset.messageSize;
  startAppearanceWatch();
  await render();
  await click("Appearance");
  expect(button("18 px").getAttribute("aria-pressed")).toBe("true");
  expect(document.documentElement.dataset.messageSize).toBe("18");
  await click("Dark");
  expect(document.documentElement.dataset.messageSize).toBe("18");
  expect(document.documentElement.dataset.reduceMotion).toBe("true");
  localStorage.setItem("fez-notify", '{"enabled":false}');
  await click("Reset appearance");
  expect(document.documentElement.dataset.messageSize).toBe("14");
  expect(document.documentElement.dataset.messageSpacing).toBe("comfortable");
  expect(document.documentElement.dataset.reduceMotion).toBe("false");
  expect(currentMode()).toBe("system");
  expect(currentTheme()).toBe("default");
  expect(localStorage.getItem("fez-notify")).toBe('{"enabled":false}');
});

it("previews an installed theme without changing it and applies a selected theme through the existing registry", async () => {
  registerTheme("test-palette", { light: { "--bg0": "#ffffff", "--fg": "#111111" }, dark: { "--bg0": "#111111", "--fg": "#eeeeee" } });
  applyTheme("test-palette");
  await render();
  await click("Appearance");
  expect(currentTheme()).toBe("test-palette");
  expect(document.querySelectorAll('[data-mode-preview]')).toHaveLength(3);
  expect(document.querySelector('[data-mode-preview="light"]')?.getAttribute("style")).toContain("#ffffff");
  await click("Theme: Default");
  expect(currentTheme()).toBe("default");
  expect(button("Theme: Default").getAttribute("aria-pressed")).toBe("true");
});

it("searches setting topics and installed extension names, opens the matching page, and explains an empty search", async () => {
  registerSettingsPanel("fez-search-fixture", () => React.createElement("p", {}, "Extension controls"), { source: "fixture" });
  await render();
  expect(document.querySelector('input[type="search"]')).not.toBeNull();
  await search("text size");
  const matches = () => [...document.querySelectorAll(".settings-nav-item")].map(b => b.textContent);
  expect(matches()).toEqual(["Appearance"]);
  await click("Appearance");
  expect(document.querySelector(".set-title")?.textContent).toBe("Appearance");
  await search("search-fixture");
  expect(matches()).toEqual(["search-fixture"]);
  await click("search-fixture");
  expect(document.body.textContent).toContain("Extension controls");
  await search("unfindable-setting");
  expect(matches()).toEqual([]);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("No settings found");
  await search("");
  expect(button("About")).toBeDefined();
});

it("updates the System preview when the Mac changes color scheme while settings is open", async () => {
  const listeners = new Set<() => void>();
  const query = { matches: false, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  vi.stubGlobal("matchMedia", () => query);
  registerTheme("system-preview", { light: { "--bg0": "#ffffff" }, dark: { "--bg0": "#121212" } });
  applyTheme("system-preview");
  startAppearanceWatch();
  await render();
  await click("Appearance");
  expect(document.querySelector('[data-mode-preview="system"]')?.getAttribute("style")).toContain("#ffffff");
  await act(async () => { query.matches = true; listeners.forEach(fn => fn()); });
  expect(document.querySelector('[data-mode-preview="system"]')?.getAttribute("style")).toContain("#121212");
});

it("falls back safely from malformed stored display preferences and reports a failed save", async () => {
  localStorage.setItem("fez-display-v1", '{"messageSize":999,"messageSpacing":"other","reduceMotion":"false"}');
  startAppearanceWatch();
  await render();
  await click("Appearance");
  expect(button("14 px").getAttribute("aria-pressed")).toBe("true");
  expect(button("Comfortable").getAttribute("aria-pressed")).toBe("true");
  expect(button("Reduce motion").getAttribute("aria-checked")).toBe("false");
  const failSave = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  try {
    await click("18 px");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save appearance");
    expect(document.documentElement.dataset.messageSize).toBe("14");
  } finally { failSave.mockRestore(); }
});
