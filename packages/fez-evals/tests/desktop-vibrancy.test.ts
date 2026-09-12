// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyMode, applyTheme, registerTheme } from "../../fez-desktop/src/gui-extensions.js";

const native = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.vibrancy;
  native.mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("__TAURI_INTERNALS__", {
    metadata: { currentWindow: { label: "main" } },
    invoke: native,
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps native sidebar material in step with the selected light, dark and system appearance", async () => {
  for (const mode of ["dark", "light", "system"] as const) {
    applyMode(mode);
    await vi.waitFor(() => expect(document.documentElement.dataset.vibrancy).toBe("sidebar"));
    expect(native).toHaveBeenLastCalledWith("plugin:window|set_theme", {
      label: "main", value: mode === "system" ? null : mode,
    }, undefined);
  }
});

it("keeps each theme's own sidebar tint when switching themes and appearance", async () => {
  registerTheme("vibrancy-fixture", {
    dark: { "--bg-rail": "#123456" }, light: { "--bg-rail": "#e6e9f0" },
  });
  applyMode("dark");
  applyTheme("vibrancy-fixture");
  expect(document.documentElement.style.getPropertyValue("--bg-rail")).toBe("#123456");
  applyMode("light");
  expect(document.documentElement.style.getPropertyValue("--bg-rail")).toBe("#e6e9f0");
  applyTheme("default");
  expect(document.documentElement.style.getPropertyValue("--bg-rail")).toBe("#eee0b7");
  await vi.waitFor(() => expect(document.documentElement.dataset.vibrancy).toBe("sidebar"));
});

it("keeps the opaque fallback when native appearance cannot be applied", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.documentElement.dataset.vibrancy = "sidebar";
  native.mockRejectedValue(new Error("native appearance unavailable"));
  applyMode("dark");
  await vi.waitFor(() => expect(document.documentElement.dataset.vibrancy).toBeUndefined());
});

it("does not make the browser preview transparent", () => {
  vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  applyMode("dark");
  expect(document.documentElement.dataset.vibrancy).toBeUndefined();
  expect(native).not.toHaveBeenCalled();
});

it("keeps unsupported desktop platforms opaque", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  applyMode("dark");
  expect(document.documentElement.dataset.vibrancy).toBeUndefined();
  expect(native).not.toHaveBeenCalled();
});
