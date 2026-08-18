import React from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fez/client";
import { registerArtifactViewer } from "./artifact-viewers";

/**
 * The GUI extension loader — the desktop half of the multi-part package
 * contract. `fez install`/`fez link` drops a package's gui part into
 * ~/.fez/gui-extensions/<name>.js; at boot each file is imported as an
 * ES module (blob URL — same-origin, no server) and its default export
 * (or `activate`) is called with the GUI api. Extensions bundle their
 * own code but use api.React so there's exactly one React in the page.
 *
 * v1 surface: registerArtifactViewer (the "obsidian extensions" seam),
 * registerTheme (CSS-variable packs), and the headless client.
 */

export interface GuiExtensionApi {
  React: typeof React;
  client: FezClient;
  registerArtifactViewer: typeof registerArtifactViewer;
  registerTheme: (name: string, vars: Record<string, string>) => void;
}

// ── theme registry ─────────────────────────────────────────────────
const themes = new Map<string, Record<string, string>>();
const THEME_KEY = "fez-gui-theme";

export function registerTheme(name: string, vars: Record<string, string>): void {
  themes.set(name, vars);
  if (localStorage.getItem(THEME_KEY) === name) applyThemeVars(vars);
}

export function themeNames(): string[] {
  return [...themes.keys()].sort();
}

export function currentTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? "default";
}

export function applyTheme(name: string): void {
  localStorage.setItem(THEME_KEY, name);
  if (name === "default") {
    document.documentElement.removeAttribute("style");
    return;
  }
  const vars = themes.get(name);
  if (vars) applyThemeVars(vars);
}

function applyThemeVars(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith("--")) document.documentElement.style.setProperty(key, value);
  }
}

// ── loader ─────────────────────────────────────────────────────────
export async function loadGuiExtensions(client: FezClient): Promise<string[]> {
  const loaded: string[] = [];
  let files: [string, string][];
  try {
    files = await invoke<[string, string][]>("list_gui_extensions");
  } catch {
    return loaded;
  }
  const api: GuiExtensionApi = { React, client, registerArtifactViewer, registerTheme };
  for (const [name, code] of files) {
    try {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const mod = (await import(/* @vite-ignore */ url)) as {
        default?: (api: GuiExtensionApi) => void;
        activate?: (api: GuiExtensionApi) => void;
      };
      URL.revokeObjectURL(url);
      const activate = mod.default ?? mod.activate;
      if (typeof activate !== "function") throw new Error("no default export / activate()");
      activate(api);
      loaded.push(name);
      console.log(`🧩 gui extension loaded: ${name}`);
    } catch (err) {
      console.error(`🧩 gui extension "${name}" failed to load:`, err);
    }
  }
  return loaded;
}
