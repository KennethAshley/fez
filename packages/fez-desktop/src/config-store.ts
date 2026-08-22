import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadKeymap, DEFAULT_KEYMAP, type ActionId } from "./keymap";

/**
 * One reactive store for LOCAL config — the settings.json / keymap.json /
 * installed-extension state that lives outside the FezClient store. It reads
 * every source in one place and re-reads on a single signal, so any view
 * that calls `useConfig()` is reactive by construction: no per-view command
 * + hand-wired event listener to forget (the "Skills & Secrets went stale"
 * class of bug). Protocol/live data stays on the FezClient store; this is
 * only for the on-disk config.
 *
 * Writers signal a change by dispatching `fez-extensions-changed` or
 * `fez-keymap-changed` (already done across the app) or calling bumpConfig().
 */
export interface AppConfig {
  /** settings.json mcpServers — installed skills + their env. */
  skills: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }>;
  /** settings.json extensionPermissions — granted perms per extension. */
  grants: Record<string, string[]>;
  /** settings.json extensionVersions — installed version per extension. */
  versions: Record<string, string>;
  /** Installed extension code parts, by name → part kinds (from ~/.fez dirs). */
  localParts: Record<string, string[]>;
  /** Merged keymap (defaults + ~/.fez/keymap.json). */
  keymap: Record<ActionId, string>;
  /** False until the first read completes — views can show a spinner. */
  loaded: boolean;
}

const EMPTY: AppConfig = { skills: {}, grants: {}, versions: {}, localParts: {}, keymap: { ...DEFAULT_KEYMAP }, loaded: false };
let snapshot: AppConfig = EMPTY;
const listeners = new Set<() => void>();

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function readAll(): Promise<AppConfig> {
  const [skills, grants, versions, parts, keymapJson] = await Promise.all([
    invoke<string>("read_skills").then((s) => safeParse(s, {})).catch(() => ({})),
    invoke<string>("read_extension_grants").then((s) => safeParse(s, {})).catch(() => ({})),
    invoke<string>("read_extension_versions").then((s) => safeParse(s, {})).catch(() => ({})),
    invoke<[string, string[]][]>("list_local_extensions").catch(() => [] as [string, string[]][]),
    invoke<string>("read_keymap").catch(() => undefined),
  ]);
  return {
    skills: skills as AppConfig["skills"],
    grants: grants as AppConfig["grants"],
    versions: versions as AppConfig["versions"],
    localParts: Object.fromEntries(parts),
    keymap: loadKeymap(keymapJson),
    loaded: true,
  };
}

/** Re-read every source and notify subscribers. */
export async function reloadConfig(): Promise<void> {
  snapshot = await readAll();
  for (const l of listeners) l();
}

/** Any local-config write calls this (or dispatches the compat events). */
export function bumpConfig(): void {
  void reloadConfig();
}

let wired = false;
function ensureWired(): void {
  if (wired) return;
  wired = true;
  window.addEventListener("fez-extensions-changed", () => void reloadConfig());
  window.addEventListener("fez-keymap-changed", () => void reloadConfig());
  void reloadConfig();
}

/** Subscribe a component to local config. Reactive by construction. */
export function useConfig(): AppConfig {
  ensureWired();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot
  );
}
