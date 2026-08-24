import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface HarnessInfo {
  id: string;
  label: string;
  installed: boolean;
}

/**
 * The agent harnesses, with what's actually INSTALLED on this machine —
 * detected via the Rust `detect_harnesses` (which looks in the real
 * install dirs, since a GUI app's PATH is stripped). Buzz-style: show
 * what's ready, flag what isn't, instead of a hardcoded list. `router` is
 * always available (a built-in classify path, not a command) and stays
 * labeled as routing-only. Optimistic while loading (assume installed) so
 * the picker doesn't flash "not installed" on open.
 */
export function useHarnesses(): HarnessInfo[] {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void invoke<string>("detect_harnesses")
      .then((json) => setInstalled(JSON.parse(json) as Record<string, boolean>))
      .catch(() => {});
  }, []);
  // The runtime is never shown to users (pi is invisible plumbing); the
  // ModelPicker only reads `installed` to decide whether Claude Code is
  // offerable. Optimistic while loading (assume installed) so the picker
  // doesn't flash a missing option on open.
  return [
    { id: "pi", label: "Built-in", installed: installed.pi ?? true },
    { id: "claude-code", label: "Claude Code", installed: installed["claude-code"] ?? true },
    { id: "router", label: "Router (routing only)", installed: true },
  ];
}
