import { useEffect, useRef, useState } from "react";
import type { AgentSelectSettings, ProcessPhase, ProcessSettings, SettingsSection } from "./declarative-gui";
import { stableChoice } from "../../../src/shared/stable-choice";

export interface SettingsHost {
  permissions: readonly string[];
  run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  spawn(bin: string, job: string, env: Record<string, string>): Promise<unknown>;
  isRunning(bin: string, job: string): Promise<boolean>;
  agents(): [string, string][];
  readPreference(key: string): Promise<unknown>;
  writePreference(key: string, value: Record<string, string>): Promise<void>;
  allowPreview(url: string): void;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function DeclarativeSettings({ sections, host }: { sections: SettingsSection[]; host: SettingsHost }) {
  return <>{sections.map((section, i) => {
    const required = ["ui", section.type === "process" ? "processes" : "read:agents"];
    const missing = required.filter(permission => !host.permissions.includes(permission));
    if (missing.length) return <p key={i} role="alert" className="settings-hint">This setting requires the recorded {missing.join(", ")} permission. Reinstall the extension and grant it to continue.</p>;
    return section.type === "process" ? <ProcessSection key={i} section={section} host={host} /> : <AgentSelectSection key={i} section={section} host={host} />;
  })}</>;
}

function ProcessSection({ section, host }: { section: ProcessSettings; host: SettingsHost }) {
  const [status, setStatus] = useState<{ phase: ProcessPhase; message: string }>({ phase: "missing", message: section.status.checkingMessage });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (running.current) { timer = setTimeout(() => void refresh(), 3000); return; }
      const started = generation.current;
      try {
        const out = await host.run(section.bin, section.status.args);
        if (out.code !== 0) throw Error(out.stderr.trim() || "Could not check process status");
        if (out.stdout.length > 65536) throw Error("Process status is too large");
        const next: unknown = JSON.parse(out.stdout);
        if (!next || typeof next !== "object" || !("phase" in next) || typeof next.phase !== "string" || !Object.hasOwn(section.status.labels, next.phase)
          || !("message" in next) || typeof next.message !== "string" || next.message.length > 4096) throw Error("Unexpected process status. Reinstall the extension.");
        let phase = next.phase as ProcessPhase;
        let detail = next.message;
        if (phase === "working" && !await host.isRunning(section.bin, section.job)) { phase = "error"; detail = section.status.stoppedMessage; }
        if (!disposed && generation.current === started) setStatus({ phase, message: detail });
      } catch (err) { if (!disposed && generation.current === started) setError(message(err)); }
      // ponytail: one status process per open section every 3s; use host
      // events if many simultaneously open process panels need polling.
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [host, section]);
  const action = async (item: ProcessSettings["actions"][number]) => {
    if (running.current || !item.enabledWhen.includes(status.phase)) return;
    running.current = true; generation.current++;
    setError(""); setNotice(""); setBusy(true);
    try {
      if (item.operation === "spawn") {
        await host.spawn(section.bin, section.job, item.env!);
        setStatus({ phase: "working", message: item.successMessage });
      } else {
        const out = await host.run(section.bin, item.args!);
        if (out.code !== 0) throw Error(out.stderr.trim() || `${item.label} failed`);
        setNotice(item.successMessage);
      }
    } catch (err) { setError(message(err)); }
    finally { running.current = false; setBusy(false); }
  };
  return <section>
    <p className="settings-hint">{section.description}</p>
    <p role="status" aria-live="polite"><strong>{section.status.labels[status.phase]}</strong> — {status.message}</p>
    <div className="set-actions">{section.actions.filter(item => !item.visibleWhen || item.visibleWhen.includes(status.phase)).map((item, i) =>
      <button key={i} className="agent-action" disabled={busy || !item.enabledWhen.includes(status.phase)} onClick={() => void action(item)}>{item.label}</button>)}</div>
    {section.hints?.filter(hint => !hint.phases || hint.phases.includes(status.phase)).map((hint, i) => <p key={i} className="settings-hint">{hint.text}</p>)}
    {error && <p role="alert" className="ob-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

function AgentSelectSection({ section, host }: { section: AgentSelectSettings; host: SettingsHost }) {
  const [agents, setAgents] = useState<[string, string][]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    let disposed = false;
    try { setAgents(host.agents().sort((a, b) => a[1].localeCompare(b[1]))); }
    catch (err) { setError(message(err)); return; }
    void host.readPreference(section.preference).then(raw => {
      if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 4096 || Object.entries(raw).some(([key, v]) => key.length > 256 || typeof v !== "string" || v.length > 256))) throw Error("Saved selections are invalid. They have not been overwritten.");
      if (!disposed) { setValues(raw as Record<string, string> ?? {}); setReady(true); }
    }).catch(err => { if (!disposed) setError(message(err)); });
    return () => { disposed = true; audio.current?.pause(); };
  }, [host, section]);
  const save = async (name: string, id: string) => {
    if (!ready || writing.current || (id && !section.options.some(option => option.id === id))) return;
    writing.current = true; setSaving(true); setError("");
    const next = { ...values };
    if (id) Object.defineProperty(next, name, { value: id, enumerable: true, writable: true, configurable: true });
    else delete next[name];
    try { await host.writePreference(section.preference, next); setValues(next); }
    catch (err) { setError(message(err)); }
    finally { writing.current = false; setSaving(false); }
  };
  const preview = async (url: string) => {
    try {
      host.allowPreview(url);
      audio.current?.pause();
      const player = new Audio();
      player.crossOrigin = "anonymous";
      player.src = url;
      audio.current = player;
      await player.play();
    } catch (err) { setError(`Preview unavailable: ${message(err)}`); }
  };
  return <section>
    {error && <p role="alert" className="ob-error">{error}</p>}
    <p className="settings-hint">{section.description}</p>
    {!agents.length && <p className="settings-hint">{section.emptyMessage}</p>}
    {agents.map(([pk, name]) => {
      const fallback = stableChoice(pk, section.options);
      const selected = section.options.find(option => Object.hasOwn(values, name) && option.id === values[name]);
      const current = selected ?? fallback;
      return <div key={pk} className="set-row"><span className="set-label">@{name}</span><div className="set-control">
        <select className="manage-select" aria-label={`${section.label} for @${name}`} disabled={!ready || saving} value={selected?.id ?? ""} onChange={event => void save(name, event.target.value)}>
          <option value="">{fallback.name} (default)</option>
          {section.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        {current.previewUrl && <button className="mini" aria-label={`Preview ${current.name}`} onClick={() => void preview(current.previewUrl!)}>▶</button>}
      </div></div>;
    })}
  </section>;
}
