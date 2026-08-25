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
/**
 * The ONE parsed door to `detect_harnesses`. The Rust command returns a
 * JSON *string*; a caller that indexes into it raw gets `undefined` for
 * every harness — which is how readiness() reported "no model" on a
 * machine with Claude Code installed, and the welcome team never came.
 */
export async function detectHarnesses(): Promise<Record<string, boolean>> {
  try {
    return JSON.parse(await invoke<string>("detect_harnesses")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function useHarnesses(): HarnessInfo[] {
  // undefined = still detecting; {} = detection FAILED. They used to be
  // one state that defaulted every harness to "installed", so a broken
  // detect offered Claude Code to machines that don't have it.
  const [installed, setInstalled] = useState<Record<string, boolean>>();
  useEffect(() => {
    void invoke<string>("detect_harnesses")
      .then((json) => setInstalled(JSON.parse(json) as Record<string, boolean>))
      .catch(() => setInstalled({}));
  }, []);
  // The runtime is never shown to users (pi is invisible plumbing); the
  // ModelPicker only reads `installed` to decide whether Claude Code is
  // offerable. Optimistic only while loading, so the picker doesn't flash
  // a missing option on open — a finished detection is trusted as-is.
  const loading = installed === undefined;
  return [
    { id: "pi", label: "Built-in", installed: installed?.pi ?? loading },
    { id: "claude-code", label: "Claude Code", installed: installed?.["claude-code"] ?? loading },
    { id: "router", label: "Router (routing only)", installed: true },
  ];
}
