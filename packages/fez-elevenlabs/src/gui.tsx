import type { IsolatedPanelApi } from "@fezchat/extension-api/gui";
import { PINNED, voiceFor } from "./voices.js";


/**
 * fez-elevenlabs, GUI part — the voice map.
 *
 * Each agent the workspace knows gets a row: name, its current voice
 * (deterministic default or override), a picker, and ▶ preview when the
 * pinned voice carries a public preview url. Writes go through the
 * prefs seam as one `voices` object; the skill reads the same file.
 * The API key is NOT here — it lives in the skill's env like every
 * other fez skill secret.
 *
 * JSX with `--jsx-factory=h` (the kanban/polls shape): the markup reads
 * as markup while the compiled output is the same host-React
 * createElement calls as before — one React on the page, no bundle.
 */
export default function activate(api: IsolatedPanelApi): void {
  const h = api.React.createElement;
  const { useState, useEffect } = api.React;
  if (!api.client) throw new Error("fez-elevenlabs needs read:channels permission");
  const { client } = api;

  function Panel(): JSX.Element {
    const [voices, setVoices] = useState<Record<string, string>>({});
    const [agents, setAgents] = useState<{ name: string; pk: string }[]>([]);

    const [error, setError] = useState("");
    const [ready, setReady] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      void api.prefs.get<Record<string, string>>("voices").then((v) => {
        setVoices(v ?? {});
        setReady(true);
      }).catch((err: unknown) => setError(String(err)));
      try {
        const list = [...client.agents().entries()].map(([pk, name]) => ({ pk, name }));
        setAgents(list.sort((a, b) => a.name.localeCompare(b.name)));
      } catch (err) { setError(String(err)); }
    }, []);

    const set = async (agent: string, id: string) => {
      if (!ready || saving) return;
      const next = { ...voices };
      if (id) next[agent] = id;
      else delete next[agent];
      setSaving(true);
      setError("");
      try {
        await api.prefs.set("voices", next);
        setVoices(next);
      } catch (err) { setError(String(err)); }
      finally { setSaving(false); }
    };

    const preview = async (url: string) => {
      try { await new Audio(url).play(); }
      catch { setError("Voice preview is unavailable in this window."); }
    };

    return (
      <div>
        {error && <p role="alert">{error}</p>}
        {agents.length === 0 && <div className="settings-hint">no agents yet — voices attach to agents.</div>}
        <div className="settings-hint">
          Each agent speaks with a stable voice — assigned from its identity, overridable here. The API key lives on
          the skill, in Settings → skills.
        </div>
        {agents.map(({ name, pk }) => {
          const current = voiceFor(pk, voices, name);
          const overridden = !!voices[name];
          return (
            <div key={name} className="set-row">
              <span className="set-label">@{name}</span>
              <select
                aria-label={`Voice for @${name}`}
                className="manage-select"
                disabled={!ready || saving}
                value={overridden ? current.id : ""}
                onChange={(e: { target: { value: string } }) => void set(name, e.target.value)}
              >
                <option value="">{current.name} (default)</option>
                {PINNED.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              {current.previewUrl && (
                <button className="mini" aria-label={`Preview ${current.name}`} onClick={() => void preview(current.previewUrl!)}>
                  ▶
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  api.registerSettingsPanel("ElevenLabs", () => <Panel />);
}
