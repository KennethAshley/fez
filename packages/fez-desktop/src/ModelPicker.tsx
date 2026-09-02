import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useHarnesses } from "./harnesses";

/**
 * Pick an agent's BRAIN — Buzz's agent-pane pattern. Users think about one
 * thing: the model. The runtime ("harness": pi/claude-code) is derived, not
 * chosen — pi is invisible plumbing, so "pi"/"Built-in" never appear. The
 * list is the actually-available brains: Claude Code (if installed) and your
 * Chutes models. Empty selection reads as "Not configured" (Buzz's readiness
 * signal). No silent auto-fill — the models load into the list; you choose.
 */

/** pi-wireable providers: pinned local-models id (sha256(baseUrl)[..10], asserted
 * in lib.rs provider_tests), plus the one fact a buyer needs — who can pay.
 * Chutes takes TAO, so an agent with its own wallet can fund itself; GM sells
 * prepaid credits only, so the owner pays. */
const WIRED = [
  { id: "chutes", local: "local-56105ece7a", group: "Chutes — Bittensor, decentralized", hint: "Runs on Chutes GPUs (Bittensor). Agents can pay for their own inference in TAO. Key: Settings → secrets → chutes." },
  { id: "gm", local: "local-ebfd09756a", group: "GM — confidential frontier models", hint: "Frontier models through GM's TEE gateway (Bittensor). Prepaid credits only — agents can't self-fund with TAO. Key: Settings → secrets → gm." },
];

export interface BrainSelection {
  harness: string;
  provider: string;
  model: string;
}

export function ModelPicker({ value, onChange }: { value: BrainSelection; onChange: (s: BrainSelection) => void }) {
  const harnesses = useHarnesses();
  const claudeInstalled = harnesses.find((h) => h.id === "claude-code")?.installed ?? false;
  const [wiredModels, setWiredModels] = useState<Record<string, string[]>>({});
  const [wireError, setWireError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Wire each key-bearing provider + list its models for the dropdown. No
    // key configured is the NORMAL state (the no-models hint already covers
    // it); every other failure — network, a malformed local-models.json —
    // used to be swallowed here while the backend produced a genuinely
    // useful message.
    void Promise.all(
      WIRED.map((w) =>
        invoke<string>("wire_provider_pi", { provider: w.id })
          .then((json) => [w.id, (JSON.parse(json) as { models: string[] }).models] as const)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/No .* key yet/i.test(msg)) setWireError(msg);
            return [w.id, []] as const;
          })
      )
    )
      .then((pairs) => setWiredModels(Object.fromEntries(pairs)))
      .finally(() => setLoading(false));
  }, []);

  // What's selected right now, derived from the raw harness/provider/model.
  const selectedWired = WIRED.find((w) => w.local === value.provider);
  const current =
    value.harness === "claude-code"
      ? "claude-code"
      : value.harness === "pi" && selectedWired && value.model
        ? `${selectedWired.id}:${value.model}`
        : value.harness === "router"
          ? "router"
          : "";

  const choose = (v: string) => {
    const wired = WIRED.find((w) => v.startsWith(`${w.id}:`));
    if (v === "claude-code") onChange({ harness: "claude-code", provider: "", model: "" });
    else if (wired) onChange({ harness: "pi", provider: wired.local, model: v.slice(wired.id.length + 1) });
    else onChange({ harness: "pi", provider: "", model: "" }); // not configured — built-in runtime, no model yet
  };

  const hasOptions = claudeInstalled || WIRED.some((w) => (wiredModels[w.id] ?? []).length > 0);

  return (
    <div className="settings-field">
      <label>model</label>
      {loading ? (
        <div className="settings-hint">◌ loading your models…</div>
      ) : (
        <select className="manage-select" value={current} onChange={(e) => choose(e.target.value)}>
          {!current && <option value="">Not configured — pick a model</option>}
          {claudeInstalled && <option value="claude-code">Claude Code</option>}
          {WIRED.filter((w) => (wiredModels[w.id] ?? []).length > 0).map((w) => (
            <optgroup key={w.id} label={w.group}>
              {wiredModels[w.id].map((m) => (
                <option key={m} value={`${w.id}:${m}`}>{m}</option>
              ))}
            </optgroup>
          ))}
          {current === "router" && <option value="router">Router (advanced — edit in the .md)</option>}
        </select>
      )}
      {current === "claude-code" && (
        <div className="settings-hint">Uses Claude Code's own model — nothing to configure here.</div>
      )}
      {selectedWired && current.startsWith(`${selectedWired.id}:`) && (
        <div className="settings-hint">{selectedWired.hint}</div>
      )}
      {wireError && <div className="settings-hint">⚠ {wireError}</div>}
      {!loading && !hasOptions && !wireError && (
        <div className="settings-hint">
          No models yet — install Claude Code, or add a Chutes or GM key in Settings → secrets, then reopen.
        </div>
      )}
    </div>
  );
}
