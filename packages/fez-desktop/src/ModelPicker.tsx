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

/** pi-wireable providers — ONE table, aligned with the backend's
 * provider_spec five (lib.rs): pinned local-models id (sha256(baseUrl)
 * [..10]), plus the one fact a buyer needs — who can pay. Every row
 * renders in the picker whether or not its key is set: fez's own bundled
 * runtime is the product, and a shelf you can't see is a shelf that
 * doesn't exist. Un-keyed rows show as "add a key to unlock". */
const WIRED = [
  { id: "chutes", local: "chutes", group: "Chutes — Bittensor, decentralized", hint: "Runs on Chutes GPUs (Bittensor). Agents can pay for their own inference in TAO. Key: Settings → secrets → chutes." },
  { id: "gm", local: "gm", group: "GM — confidential frontier models", hint: "Frontier models through GM's TEE gateway (Bittensor). Prepaid credits only — agents can't self-fund with TAO. Key: Settings → secrets → gm." },
  { id: "anthropic", local: "anthropic", group: "Anthropic — direct API", hint: "Claude models over your own Anthropic API key (metered per token — separate from a Claude Code subscription). Key: Settings → secrets → anthropic." },
  { id: "openai", local: "openai", group: "OpenAI", hint: "GPT models over your OpenAI API key. Key: Settings → secrets → openai." },
  { id: "openrouter", local: "openrouter", group: "OpenRouter — many labs, one key", hint: "Hundreds of models through one OpenRouter key. Key: Settings → secrets → openrouter." },
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
  // Plain provider ids now (pi's models.json providers key). Old personas
  // may still carry the legacy local-<hash> id — match those too so their
  // editor doesn't read as unconfigured.
  const LEGACY: Record<string, string> = { "local-56105ece7a": "chutes", "local-ebfd09756a": "gm", "local-3ce36528bf": "anthropic", "local-d9617135d6": "openai", "local-76ef4ad6f0": "openrouter" };
  const effectiveProvider = LEGACY[value.provider] ?? value.provider;
  const selectedWired = WIRED.find((w) => w.local === effectiveProvider);
  const current =
    value.harness === "claude-code"
      ? "claude-code"
      : value.harness === "pi" && selectedWired && value.model
        ? `${selectedWired.id}:${value.model}`
        : value.harness === "router"
          ? "router"
          : "";

  // Picking a locked shelf doesn't change the agent — it tells you where
  // the key goes. The selection stays put; the hint does the teaching.
  const [lockedPick, setLockedPick] = useState<string>();
  const choose = (v: string) => {
    if (v.startsWith("locked:")) { setLockedPick(v.slice("locked:".length)); return; }
    setLockedPick(undefined);
    const wired = WIRED.find((w) => v.startsWith(`${w.id}:`));
    if (v === "claude-code") onChange({ harness: "claude-code", provider: "", model: "" });
    else if (wired) onChange({ harness: "pi", provider: wired.local, model: v.slice(wired.id.length + 1) });
    else onChange({ harness: "pi", provider: "", model: "" }); // not configured — built-in runtime, no model yet
  };

  const hasOptions = claudeInstalled || WIRED.some((w) => (wiredModels[w.id] ?? []).length > 0);
  const lockedEntry = WIRED.find((w) => w.id === lockedPick);

  return (
    <div className="settings-field">
      <label>model</label>
      {loading ? (
        <div className="settings-hint">◌ loading your models…</div>
      ) : (
        <select className="manage-select" value={lockedPick ? `locked:${lockedPick}` : current} onChange={(e) => choose(e.target.value)}>
          {!current && !lockedPick && <option value="">Not configured — pick a model</option>}
          {/* fez's own runtime leads the list; the guest harness follows. */}
          {WIRED.map((w) => {
            const models = wiredModels[w.id] ?? [];
            return (
              <optgroup key={w.id} label={w.group}>
                {models.length > 0 ? (
                  models.map((m) => <option key={m} value={`${w.id}:${m}`}>{m}</option>)
                ) : (
                  <option value={`locked:${w.id}`}>add a key to unlock…</option>
                )}
              </optgroup>
            );
          })}
          {claudeInstalled && (
            <optgroup label="On this machine">
              <option value="claude-code">Claude Code</option>
            </optgroup>
          )}
          {current === "router" && <option value="router">Router (advanced — edit in the .md)</option>}
        </select>
      )}
      {current === "claude-code" && !lockedPick && (
        <div className="settings-hint">Uses Claude Code's own model — nothing to configure here.</div>
      )}
      {selectedWired && current.startsWith(`${selectedWired.id}:`) && !lockedPick && (
        <div className="settings-hint">{selectedWired.hint}</div>
      )}
      {lockedEntry && (
        <div className="settings-hint">
          🔒 {lockedEntry.hint} Add the key, then reopen this editor — the models list themselves.
        </div>
      )}
      {wireError && <div className="settings-hint">⚠ {wireError}</div>}
      {!loading && !hasOptions && !wireError && !lockedPick && (
        <div className="settings-hint">
          Every shelf is locked right now — add any provider key in Settings → secrets (or install Claude
          Code) and the models appear here.
        </div>
      )}
    </div>
  );
}
