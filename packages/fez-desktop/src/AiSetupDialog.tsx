import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flash } from "./toast";
import { ConnectAiStep, type Brain } from "./Onboarding";
import { parsePersonaBrain, STARTER_TEAM, withPersonaBrain } from "./welcome-core";

export default function AiSetupDialog({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [brain, setBrain] = useState<Brain>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const affected = useRef(new Set(["fez"]));
  useEffect(() => { dialog.current?.showModal(); }, []);

  const save = async () => {
    if (!brain.harness) return;
    setSaving(true);
    setError(undefined);
    try {
      for (const name of ["fez", ...STARTER_TEAM.map((p) => p.id)]) {
        const md = await invoke<string>("read_persona", { name });
        const previous = parsePersonaBrain(md);
        // Only unconfigured teammates inherit this setup; keep any independent choice.
        if (!affected.current.has(name) && (previous.harness !== "pi" || previous.model)) continue;
        affected.current.add(name);
        const content = withPersonaBrain(md, { ...brain, harness: brain.harness });
        if (content !== md) await invoke("update_persona", { name, content });
      }
      flash("AI setup saved. Restart running agents from their profiles to apply it; current work keeps running.");
      onConnected();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return <dialog ref={dialog} className="ob-card ob-connect ai-setup-dialog" aria-label="Connect your AI"
    onCancel={(e) => { e.preventDefault(); if (!saving) onClose(); }}>
    <ConnectAiStep brain={brain} setBrain={setBrain} saving={saving} onNext={() => void save()} onBack={onClose} />
    {saving && <p role="status">Saving your team’s AI setup…</p>}
    {error && <p role="alert" className="ob-error">{error}</p>}
  </dialog>;
}
