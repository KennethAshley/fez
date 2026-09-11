import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SkillEntry } from "@fezchat/client";
import { SecretField } from "./SkillSecrets";
import { bumpConfig } from "./config-store";
import { CONNECTABLE } from "./extensions-catalog";

export type ToolConfig = SkillEntry & { auth?: string; headers?: { name: string; value: string }[] };

/** Configuration is saved locally; credential presence is not a connection test. */
export default function ToolSetup({ name, config, children }: { name: string; config: ToolConfig; children: ReactNode }) {
  const [stored, setStored] = useState<Record<string, boolean>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const oauth = config.auth === "oauth";
  const keys = oauth ? ["OAUTH"] : config.url ? (config.headers ?? []).map(h => h.name) : Object.keys(config.env ?? {});
  const signature = JSON.stringify(keys);
  useEffect(() => {
    let cancelled = false;
    setStored(undefined);
    setError(undefined);
    void Promise.all(keys.map(async key => [key, await invoke<boolean>("has_skill_secret", { skill: name, key })] as const))
      .then(entries => { if (!cancelled) setStored(Object.fromEntries(entries)); })
      .catch(err => { if (!cancelled) setError(`Could not check credentials: ${String(err)}`); });
    return () => { cancelled = true; };
    // The serialized names make credential checks independent of render identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, signature]);
  const missing = stored && keys.some(key => !stored[key] && !(config.url ? config.headers?.find(h => h.name === key)?.value : config.env?.[key])?.trim());
  const addKey = async () => {
    const nextKey = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(nextKey) || keys.includes(nextKey)) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = config.url
        ? { ...config, headers: [...(config.headers ?? []), { name: nextKey, value: "" }] }
        : { ...config, env: { ...config.env, [nextKey]: "" } };
      await invoke("write_skill", { name, configJson: JSON.stringify(next) });
      setKey("");
      bumpConfig();
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const secretSaved = async (key: string) => {
    setStored(prev => ({ ...prev, [key]: true }));
    // Old plaintext headers take precedence at spawn. Clear that value
    // after storing its replacement so the agent uses the keychain.
    const plaintext = config.url ? config.headers?.find(h => h.name === key)?.value : config.env?.[key];
    if (!plaintext) return;
    try {
      const next = config.url
        ? { ...config, headers: config.headers?.map(h => h.name === key ? { ...h, value: "" } : h) }
        : { ...config, env: { ...config.env, [key]: "" } };
      await invoke("write_skill", { name, configJson: JSON.stringify(next) });
      bumpConfig();
    } catch (err) { setError(`Credential saved, but could not remove its old value from setup: ${String(err)}`); }
  };
  return <details className="tool-setup">
    <summary>Configure <span className={missing ? "tool-status needs-setup" : "tool-status"}>
      {error ? "Check failed" : !stored ? "Checking setup…" : missing ? "Needs setup" : keys.length ? "Credentials saved" : "No credentials specified"}
    </span></summary>
    <div className="tool-setup-body">
      <p className="settings-hint">{config.url ? "Agents connect to this server." : "This command runs on your computer when an assigned agent starts."} Saving setup does not test the connection.</p>
      <code className="tool-command">{config.url ?? [config.command, ...(config.args ?? [])].join(" ")}</code>
      {oauth ? <>
        <p className="settings-hint">Sign-in is managed by the service. Tokens stay in your keychain.</p>
        {CONNECTABLE.some(c => c.key === name) && <button className="agent-action" disabled={busy} onClick={() => {
          setBusy(true);
          setError(undefined);
          void invoke("connect_service", { key: name })
            .then(() => { setStored({ OAUTH: true }); bumpConfig(); })
            .catch(err => setError(String(err)))
            .finally(() => setBusy(false));
        }}>{busy ? "Signing in…" : "Sign in"}</button>}
      </> : <>
        {keys.map(key => <div className="tool-secret" key={key}>
          <span>{key} {stored?.[key] && <small>Saved in keychain</small>}</span>
          <SecretField skill={name} envKey={key} onSaved={() => void secretSaved(key)} />
        </div>)}
        <form className="tool-key-form" onSubmit={e => { e.preventDefault(); void addKey(); }}>
          <label>{config.url ? "Authentication header" : "Environment variable"}
            <input className="manage-input" value={key} placeholder={config.url ? "Authorization" : "API_KEY"} onChange={e => setKey(e.target.value)} />
          </label>
          <button className="mini" disabled={busy || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key.trim()) || keys.includes(key.trim())}>Add credential</button>
        </form>
        {config.url && <p className="settings-hint">For bearer authentication, add Authorization and save the value as “Bearer” followed by a space and your token.</p>}
      </>}
      {error && <p role="alert" className="ob-error">{error}</p>}
      {children}
    </div>
  </details>;
}
