import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
import type { ConfigField, SubmissionStatus, SubmissionTest } from "@fezchat/extension-api";
import type { MinerEntry } from "./state.js";
import { ensureMiningSkill } from "./persona-skill.js";
import { submissionVersions } from "./gui-rows.js";
import { validateConfig } from "./config.js";
import { createDevelopmentGui } from "./development-gui.js";

type PanelProps = {
  netuid: number;
  persona?: string;
  personas?: string[];
  entry?: MinerEntry;
  onPersonaChange?: (persona: string) => void;
  onClose?: () => void;
  onChange?: () => Promise<void>;
};

// Keep the host React instance and the existing mining card/theme styles.
export function createSubmissionGui(api: GuiExtensionApi, styles: { card: Record<string, string | number>; dim: Record<string, string | number> }) {
  const h = api.React.createElement;
  const { useState, useEffect, useRef } = api.React;
  const run = api.processes?.run;
  const { DevelopmentPanel } = createDevelopmentGui(api, styles);
  type Values = Record<string, string | number | boolean>;

  function SubmissionSummary({ status, error }: { status?: SubmissionStatus; error?: string }): JSX.Element {
    const { latest, active } = submissionVersions(status);
    const version = (v: typeof latest) => v ? `${v.name} · v${v.version} (${v.id})` : "none reported";
    return <div className="skill-desc" style={styles.dim}>
      <div>{error ? "Stale · last known " : ""}{status?.phase ?? "status unknown"}</div>
      <div>Latest: {version(latest)}</div>
      <div>Active: {active ? version(active) : status?.activeVersionId ?? "none reported"}</div>
      {status ? <div>Checked: <time dateTime={status.checkedAt}>{status.checkedAt}</time></div> : null}
      {error ? <div className="ob-error" role="alert">{error}</div> : null}
    </div>;
  }

  async function json(args: string[]): Promise<unknown> {
    if (!run) throw Error("Mining needs the processes permission.");
    const out = await run("fez-mine", args);
    if (out.code !== 0) throw Error(out.stderr.trim() || `fez-mine ${args[0]} exited ${out.code}`);
    return JSON.parse(out.stdout);
  }

  function Details(props: PanelProps & { persona: string }): JSX.Element {
    const { netuid, persona } = props;
    const initial = props.entry?.persona === persona && props.entry.netuid === netuid ? props.entry : undefined;
    const [status, setStatus] = useState(initial?.submission);
    const [statusError, setStatusError] = useState(initial?.submissionError);
    const [error, setError] = useState<string | undefined>(undefined);
    const [network, setNetwork] = useState<string | undefined>(undefined);
    const [notice, setNotice] = useState("");
    const [descriptorReady, setDescriptorReady] = useState(false);
    const [schema, setSchema] = useState<ConfigField[]>([]);
    const [settings, setSettings] = useState<Values>({});
    const [drafts, setDrafts] = useState<Values>({});
    const [setupReady, setSetupReady] = useState(false);
    const [setupMessage, setSetupMessage] = useState("");
    const [file, setFile] = useState("");
    const [receipt, setReceipt] = useState<SubmissionTest | undefined>(undefined);
    const [busy, setBusy] = useState<string | undefined>(undefined);
    const [confirm, setConfirm] = useState<{ action: "register" | "submit"; message: string } | undefined>(undefined);
    const alive = useRef(false);
    const inFlight = useRef(false);
    const confirming = useRef(false);
    const fileRevision = useRef(0);
    const granted = useRef(false);
    const changed = useRef(props.onChange);
    changed.current = props.onChange;

    const report = (message: string) => { setError(message); api.toast?.(message, "error"); };
    const grant = async () => {
      if (granted.current) return;
      if (!api.personas) throw Error("Grant the personas permission to enable this persona's mining tools.");
      const invited = await api.personas.invite?.(persona, "bot");
      if (!alive.current) return;
      if (invited && invited !== "invited") throw Error(`Could not invite ${persona}: ${invited}`);
      const md = await api.personas.read(persona);
      if (!alive.current) return;
      const next = ensureMiningSkill(md);
      if (next !== md) await api.personas.update(persona, next);
      granted.current = true;
    };

    async function execute(action: "status" | "register" | "test" | "submit" | "cost"): Promise<void> {
      if (!run || !persona || inFlight.current) return;
      if ((action === "test" || action === "submit") && !file.startsWith("/")) return;
      if (action === "submit" && (!receipt || !descriptorReady)) return;
      inFlight.current = true;
      const revision = fileRevision.current;
      setBusy(action);
      setError(undefined);
      if (action === "test") setReceipt(undefined);
      try {
        if (action === "cost") {
          const cost = await json(["cost", "--netuid", String(netuid), "--json"]) as { netuid?: number; tao?: string };
          if (cost.netuid !== netuid || typeof cost.tao !== "string" || !/^\d+(\.\d+)?$/.test(cost.tao)) throw Error("Invalid registration cost response");
          if (!alive.current) return;
          confirming.current = true;
          setConfirm({ action: "register", message: `Register ${persona} on netuid ${netuid} (${network})? This may burn approximately ${cost.tao} tTAO test tokens. Already registered hotkeys skip the burn. The live cost can change before registration.` });
          return;
        }
        const args = ["submission", action, "--netuid", String(netuid), "--persona", persona, "--json"];
        if (action === "test" || action === "submit") args.push("--file", file);
        if (action === "submit") args.push("--sha256", receipt!.sha256);
        const result = await json(args);
        if (!alive.current) return;
        if (action === "test") {
          const tested = result as SubmissionTest;
          if (!tested || !/^[a-f0-9]{64}$/.test(tested.sha256) || (tested.prediction !== undefined && !Number.isFinite(tested.prediction)) || typeof tested.detail !== "string") throw Error("Invalid test receipt");
          if (revision === fileRevision.current) setReceipt(tested);
        } else {
          const snapshot = result as SubmissionStatus;
          if (!snapshot || !["not-submitted", "pending", "active", "failed"].includes(snapshot.phase) || !Array.isArray(snapshot.versions)
            || typeof snapshot.hotkey !== "string" || typeof snapshot.detail !== "string" || !Number.isFinite(Date.parse(snapshot.checkedAt))
            || snapshot.versions.some(v => !v || typeof v.id !== "string" || typeof v.name !== "string" || !Number.isFinite(v.version))) throw Error("Invalid submission status response");
          setStatus(snapshot);
          setStatusError(undefined);
          if (action === "submit") setReceipt(undefined);
          if (alive.current) await changed.current?.();
        }
      } catch (err) {
        if (!alive.current) return;
        const message = err instanceof Error ? err.message : String(err);
        if (action === "status" || action === "register" || action === "submit") setStatusError(message);
        report(message);
      } finally {
        inFlight.current = false;
        if (alive.current) setBusy(undefined);
      }
    }

    async function loadSetup(fields: ConfigField[]): Promise<void> {
      const current = await json(["config", "get", "--netuid", String(netuid), "--persona", persona, "--json"]) as Values;
      if (!alive.current) return;
      const masked: Values = {};
      for (const f of fields) {
        // Only the CLI's presence marker is accepted for secrets, never a value.
        masked[f.key] = f.type === "secret" ? (current[f.key] === "set" ? "set" : "unset") : (current[f.key] ?? f.default ?? "");
      }
      setSettings(masked);
      setSetupReady(true);
    }

    useEffect(() => {
      alive.current = true;
      void grant().catch(() => { if (alive.current) report("Could not enable mining tools for this persona. Reopen the panel to retry."); });
      void json(["describe", "--netuid", String(netuid), "--json"]).then(async value => {
        const descriptor = value as { mode?: string; network?: string; submissionNotice?: string; config?: ConfigField[] };
        if (descriptor.mode !== "submission") throw Error("This subnet has no submission adapter");
        if (!alive.current) return;
        if (alive.current) setNetwork(descriptor.network);
        if (alive.current && typeof descriptor.submissionNotice === "string") setNotice(descriptor.submissionNotice);
        if (alive.current) setDescriptorReady(true);
        const fields = descriptor.config ?? [];
        setSchema(fields);
        if (!fields.length) return;
        await loadSetup(fields);
      }).catch(() => { if (alive.current) report("Could not load miner setup. Reopen the panel to retry."); });
      void execute("status");
      // Single-flight, status only. Candidate testing and upload are explicit.
      const timer = setInterval(() => { if (!confirming.current) void execute("status"); }, 30_000);
      return () => { alive.current = false; clearInterval(timer); };
    }, [netuid, persona]);

    const cancel = () => { confirming.current = false; setConfirm(undefined); };
    const changeSource = (path: string) => { fileRevision.current++; setFile(path); setReceipt(undefined); cancel(); };
    const hasDrafts = Object.keys(drafts).length > 0;
    const outstanding = schema.filter(f => f.required && (f.type === "secret" ? settings[f.key] !== "set" : settings[f.key] === undefined || settings[f.key] === "")).map(f => f.label);
    async function refreshSetup(): Promise<void> {
      if (hasDrafts || inFlight.current) return;
      inFlight.current = true;
      setBusy("refreshing setup");
      setSetupMessage("");
      // Credentials can have changed externally even when presence is still "set".
      fileRevision.current++;
      setReceipt(undefined);
      cancel();
      try { await loadSetup(schema); }
      catch { if (alive.current) setSetupMessage("Could not refresh setup. Try again."); }
      finally { inFlight.current = false; if (alive.current) setBusy(undefined); }
    }
    async function saveSetup(): Promise<void> {
      if (!run || !setupReady || inFlight.current) return;
      const updates = schema.filter(f => drafts[f.key] !== undefined && drafts[f.key] !== "" && (f.type === "secret" || String(drafts[f.key]) !== String(settings[f.key])));
      // Development setup can precede enrollment; submission validates the full config.
      const invalid = validateConfig(updates, drafts);
      if (invalid) { setSetupMessage(`${invalid} is missing or invalid`); return; }
      if (!updates.length) { setDrafts({}); setSetupMessage("No setup changes"); return; }
      inFlight.current = true;
      setBusy("saving setup");
      setSetupMessage("");
      fileRevision.current++;
      setReceipt(undefined);
      cancel();
      const saved = { ...settings };
      try {
        for (const f of updates) {
          if (!alive.current) return;
          const args = ["config", "set", "--netuid", String(netuid), "--persona", persona, "--key", f.key, "--value", String(drafts[f.key])];
          if (f.type === "secret") args.push("--secret");
          const out = await run("fez-mine", args);
          if (out.code !== 0) throw Error("Config write failed");
          saved[f.key] = f.type === "secret" ? "set" : drafts[f.key];
        }
        if (!alive.current) return;
        setSettings(saved);
        setDrafts({});
        setSetupMessage("Setup saved");
      } catch {
        // Process failures may echo argv (including credentials). Never display them.
        if (alive.current) setSetupMessage("Could not save setup. Some fields may have saved; retry to finish.");
      } finally {
        inFlight.current = false;
        if (alive.current) setBusy(undefined);
      }
    }
    return <div style={{ display: "grid", gap: 8, marginTop: 12, overflowWrap: "anywhere" }}>
      <div className="skill-desc" style={styles.dim}>{persona} · netuid {netuid}{network ? ` · ${network}` : ""}{status?.uid !== undefined ? ` · uid ${status.uid}` : ""}</div>
      <SubmissionSummary status={status} error={statusError} />
      {error && error !== statusError ? <p className="ob-error" role="alert">{error}</p> : null}
      {status ? <p className="skill-desc">{status.detail}</p> : null}
      <p style={styles.dim}>Activation is not proof of execution, scoring, or rewards.</p>
      {status?.versions.map(v => <div key={v.id} className="skill-desc" style={styles.dim}>
        {v.name} · v{v.version} · {v.id} · created {v.createdAt}{v.activatedAt ? ` · activated ${v.activatedAt}` : " · activation not reported"}
      </div>)}
      {status?.nextUploadAt ? <p style={styles.dim}>Next upload allowed: {status.nextUploadAt}</p> : null}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button className="agent-action" disabled={!run || !!busy || !!confirm} onClick={() => void execute("status")}>Refresh / adopt</button>
        <button className="agent-action" disabled={!run || !!busy || !!confirm || network !== "test"} onClick={() => void execute("cost")}>Register</button>
      </div>
      <p style={styles.dim}>Refresh adopts an existing submission. Registration is optional and requires confirmation.</p>
      {schema.length ? <fieldset disabled={!setupReady || !!busy} style={{ border: 0, padding: 0 }}>
        <legend>Miner setup</legend>
        <p style={styles.dim}>Secrets stay in local secure storage. Leave a secret blank to keep it. Saving does not register, submit, or start mining.</p>
        {setupReady && outstanding.length ? <p style={styles.dim}>Required for submission: {outstanding.join(", ")}. You can save development settings now.</p> : null}
        {schema.map(f => {
          const value = drafts[f.key] ?? (f.type === "secret" ? "" : settings[f.key] ?? "");
          const change = (v: string | boolean) => { setDrafts(prev => ({ ...prev, [f.key]: v })); setSetupMessage(""); };
          return <label key={f.key} style={{ display: "grid", gap: 4, marginTop: 8 }}>
            {f.label}{f.required ? " *" : ""}
            {f.type === "select" ? <select className="manage-input" aria-label={f.label} value={String(value)} onChange={(e: { target: { value: string } }) => change(e.target.value)}>
              <option value="">Choose…</option>{f.options?.map(o => <option key={o} value={o}>{o}</option>)}
            </select> : f.type === "boolean" ? <input aria-label={f.label} type="checkbox" checked={value === true || value === "true"} onChange={(e: { target: { checked: boolean } }) => change(e.target.checked)} /> :
              <input className="manage-input" aria-label={f.label} type={f.type === "secret" ? "password" : f.type === "number" ? "number" : "text"} autoComplete={f.type === "secret" ? "new-password" : "off"} value={String(value)} onChange={(e: { target: { value: string } }) => change(e.target.value)} />}
            {f.type === "secret" ? <span style={styles.dim}>{settings[f.key] === "set" ? "Secret configured" : "Secret not configured"}</span> : null}
            {f.help ? <span style={styles.dim}>{f.help}</span> : null}
          </label>;
        })}
        <button className="agent-action" onClick={() => void saveSetup()}>Save setup</button>
        <button className="skill-link" disabled={hasDrafts} onClick={() => void refreshSetup()}>Refresh setup</button>
        {hasDrafts ? <p style={styles.dim}>Save your drafts before refreshing setup.</p> : null}
        {setupMessage ? <p role="status">{setupMessage}</p> : null}
      </fieldset> : null}
      <DevelopmentPanel netuid={netuid} persona={persona} onSource={changeSource} />
      <label style={{ display: "grid", gap: 6 }}>Source file (absolute .py path)
        <input className="manage-input" style={{ width: "100%", boxSizing: "border-box" }} aria-label="Source file" value={file} placeholder="/absolute/path/miner.py"
          onChange={(e: { target: { value: string } }) => changeSource(e.target.value)} />
      </label>
      <p style={styles.dim}>Checks require local Docker and run in an isolated, networkless container without wallet keys. The result describes what was checked.</p>
      {notice ? <p className="skill-desc">{notice}</p> : null}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button className="agent-action" disabled={!run || !!busy || !!confirm || !file.startsWith("/")} onClick={() => void execute("test")}>Test</button>
        <button className="agent-action" disabled={!run || !!busy || !!confirm || !receipt || !descriptorReady} onClick={() => {
          confirming.current = true;
          setConfirm({ action: "submit", message: `${notice ? notice + " " : ""}Submit the tested version for ${persona}? This schedules or replaces validator code. Next upload allowed: ${status?.nextUploadAt ?? "not reported; the adapter enforces its cooldown"}. Only bytes matching the tested SHA256 will be accepted.` });
        }}>Submit tested version</button>
      </div>
      {busy ? <p role="status" style={styles.dim}>{busy}…</p> : null}
      {receipt ? <div style={{ ...styles.dim, marginTop: 8, overflowWrap: "anywhere" }}>
        <div>Tested SHA256: {receipt.sha256}</div>{receipt.prediction !== undefined ? <div>Prediction: {receipt.prediction}</div> : null}<div>{receipt.detail}</div>
      </div> : null}
      {confirm ? <div role="group" aria-label="Confirm mining action" style={{ marginTop: 10 }}>
        <p className="skill-desc">{confirm.message}</p>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="agent-action" disabled={!!busy} onClick={() => { const action = confirm.action; cancel(); void execute(action); }}>
            {confirm.action === "register" ? "Confirm registration" : "Confirm submission"}
          </button>
          <button className="skill-link" onClick={cancel}>Cancel</button>
        </div>
      </div> : null}
    </div>;
  }

  function SubmissionPanel(props: PanelProps): JSX.Element {
    const persona = props.persona ?? props.personas?.[0] ?? "";
    return <div style={{ ...styles.card, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span className="skill-name">Submission miner · netuid {props.netuid}</span>
        {props.onClose ? <button className="skill-link" onClick={props.onClose}>Close</button> : null}
      </div>
      {props.personas ? <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>Persona
        <select className="manage-input" aria-label="Submission persona" value={persona} onChange={(e: { target: { value: string } }) => props.onPersonaChange?.(e.target.value)}>
          {[...new Set([persona, ...props.personas])].filter(Boolean).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label> : null}
      {persona ? <Details key={`${props.netuid}:${persona}`} {...props} persona={persona} /> : <p className="settings-hint">Create a persona before mining.</p>}
    </div>;
  }
  return { SubmissionPanel, SubmissionSummary };
}
