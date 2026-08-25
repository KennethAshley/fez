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

const CHUTES = "local-56105ece7a";

export interface BrainSelection {
  harness: string;
  provider: string;
  model: string;
}

export function ModelPicker({ value, onChange }: { value: BrainSelection; onChange: (s: BrainSelection) => void }) {
  const harnesses = useHarnesses();
  const claudeInstalled = harnesses.find((h) => h.id === "claude-code")?.installed ?? false;
  const [chutesModels, setChutesModels] = useState<string[]>([]);
  const [chutesError, setChutesError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Wire Chutes + list its models for the dropdown. No key configured is
    // the NORMAL state (the no-models hint already covers it); every other
    // failure — network, a malformed local-models.json — used to be
    // swallowed here while the backend produced a genuinely useful message.
    void invoke<string>("wire_chutes_pi")
      .then((json) => setChutesModels((JSON.parse(json) as { models: string[] }).models))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Chutes key/i.test(msg)) setChutesError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  // What's selected right now, derived from the raw harness/provider/model.
  const current =
    value.harness === "claude-code"
      ? "claude-code"
      : value.harness === "pi" && value.provider === CHUTES && value.model
        ? `chutes:${value.model}`
        : value.harness === "router"
          ? "router"
          : "";

  const choose = (v: string) => {
    if (v === "claude-code") onChange({ harness: "claude-code", provider: "", model: "" });
    else if (v.startsWith("chutes:")) onChange({ harness: "pi", provider: CHUTES, model: v.slice("chutes:".length) });
    else onChange({ harness: "pi", provider: "", model: "" }); // not configured — built-in runtime, no model yet
  };

  const hasOptions = claudeInstalled || chutesModels.length > 0;

  return (
    <div className="settings-field">
      <label>model</label>
      {loading ? (
        <div className="settings-hint">◌ loading your models…</div>
      ) : (
        <select className="manage-select" value={current} onChange={(e) => choose(e.target.value)}>
          {!current && <option value="">Not configured — pick a model</option>}
          {claudeInstalled && <option value="claude-code">Claude Code</option>}
          {chutesModels.length > 0 && (
            <optgroup label="Chutes — Bittensor, decentralized">
              {chutesModels.map((m) => (
                <option key={m} value={`chutes:${m}`}>{m}</option>
              ))}
            </optgroup>
          )}
          {current === "router" && <option value="router">Router (advanced — edit in the .md)</option>}
        </select>
      )}
      {current === "claude-code" && (
        <div className="settings-hint">Uses Claude Code's own model — nothing to configure here.</div>
      )}
      {current.startsWith("chutes:") && (
        <div className="settings-hint">Runs on Chutes GPUs (Bittensor). Key: Settings → secrets → chutes.</div>
      )}
      {chutesError && <div className="settings-hint">⚠ Chutes: {chutesError}</div>}
      {!loading && !hasOptions && !chutesError && (
        <div className="settings-hint">
          No models yet — install Claude Code, or add a Chutes key in Settings → secrets → chutes, then reopen.
        </div>
      )}
    </div>
  );
}
