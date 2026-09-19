import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { localAgents, useHarnesses } from "./harnesses";
import { providerId } from "./providers";
import { listModelProviders } from "./model-providers";

/**
 * Pick an agent's BRAIN — Buzz's agent-pane pattern. Users think about one
 * thing: the model. The runtime ("harness": pi/claude-code) is derived, not
 * chosen — pi is invisible plumbing, so "pi"/"Built-in" never appear. The
 * list is the actually-available brains: Claude Code (if installed) and your
 * Chutes models. Empty selection reads as "Not configured" (Buzz's readiness
 * signal). No silent auto-fill — the models load into the list; you choose.
 */

/** pi-wireable providers — ONE table, aligned with the backend's
 * provider_spec rows (lib.rs): pinned local-models id (sha256(baseUrl)
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
  { id: "actual", local: "actual", group: "Actual — your own machines", hint: "Open models on your own hardware via Actual's private relay (Bittensor SN95). Needs the actual daemon on an authorized device. Key: Settings → secrets → actual." },
  { id: "engy", local: "engy", group: "Engy — verified inference", hint: "GLM, Qwen, and DeepSeek through Engy's verified-inference gateway. Key: Settings → secrets → engy." },
];

export interface BrainSelection {
  harness: string;
  provider: string;
  model: string;
  modelProfile?: string;
}

export function ModelPicker({ value, onChange }: { value: BrainSelection; onChange: (s: BrainSelection) => void }) {
  const harnesses = useHarnesses();
  const installedAgents = localAgents.filter((a) => harnesses.some((h) => h.id === a.id && h.installed));
  const [wiredModels, setWiredModels] = useState<Record<string, string[]>>({});
  const [wireError, setWireError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [extensions, setExtensions] = useState<Awaited<ReturnType<typeof listModelProviders>>>([]);

  useEffect(() => {
    let active = true;
    const refresh = () => { void listModelProviders().then((items) => { if (active) setExtensions(items); }); };
    refresh();
    window.addEventListener("fez-gui-extensions-changed", refresh);
    return () => { active = false; window.removeEventListener("fez-gui-extensions-changed", refresh); };
  }, []);

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
  const effectiveProvider = providerId(value.provider);
  const selectedWired = WIRED.find((w) => w.local === effectiveProvider);
  const selectedExtension = extensions.find(({ provider }) => provider.id === value.modelProfile);
  const selectedModel = selectedExtension?.models.find((model) => model.id === value.model);
  const extValue = value.modelProfile ? `${value.modelProfile}:${value.model}` : "";
  const current =
    value.modelProfile ? extValue
      : localAgents.some((a) => a.id === value.harness)
      ? value.harness
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
    const extension = extensions.find(({ provider }) => v.startsWith(`${provider.id}:`));
    if (extension) onChange({ harness: "pi", provider: extension.provider.id, model: v.slice(extension.provider.id.length + 1), modelProfile: extension.provider.id });
    else if (localAgents.some((a) => a.id === v)) onChange({ harness: v, provider: "", model: "", modelProfile: "" });
    else if (wired) onChange({ harness: "pi", provider: wired.local, model: v.slice(wired.id.length + 1), modelProfile: "" });
    else onChange({ harness: "pi", provider: "", model: "", modelProfile: "" }); // not configured
  };

  const hasOptions = installedAgents.length > 0 || WIRED.some((w) => (wiredModels[w.id] ?? []).length > 0) || extensions.some((entry) => entry.models.length > 0);
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
          {/* A model that is ready needs no adjective — the name alone is the
              option. Only a shelf you cannot use right now says so, and it
              says it in words rather than as a third dot-joined fragment. */}
          {extensions.map(({ provider, models }) => (
            <optgroup key={provider.id} label={provider.label}>
              {models.map((model) => (
                <option key={model.id} value={`${provider.id}:${model.id}`}>
                  {model.status === "ready" ? model.label : `${model.label} (${model.status})`}
                </option>
              ))}
            </optgroup>
          ))}
          {value.modelProfile && !selectedModel && (
            <option value={extValue}>{value.model} · unavailable</option>
          )}
          {installedAgents.length > 0 && (
            <optgroup label="On this machine">
              {installedAgents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </optgroup>
          )}
          {current === "router" && <option value="router">Router (advanced — edit in the .md)</option>}
        </select>
      )}
      {localAgents.some((a) => a.id === current) && !lockedPick && (
        <div className="settings-hint">Uses {localAgents.find((a) => a.id === current)?.label}'s existing sign-in and model setup.</div>
      )}
      {selectedWired && current.startsWith(`${selectedWired.id}:`) && !lockedPick && (
        <div className="settings-hint">{selectedWired.hint}</div>
      )}
      {/* One fact per line. Run together, the provider name, the model's own
          detail sentence and a failure all read as a single paragraph, and
          the failure — the only line you must act on — disappears into it. */}
      {value.modelProfile && !lockedPick && (
        <div className="settings-hint">
          <p>{selectedExtension?.provider.label ?? value.modelProfile}</p>
          {selectedModel?.detail && <p>{selectedModel.detail}</p>}
          {selectedExtension?.error && <p>⚠ {selectedExtension.error}</p>}
          {!selectedExtension && <p>Restore this extension before saving.</p>}
        </div>
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
