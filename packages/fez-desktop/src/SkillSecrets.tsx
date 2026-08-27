import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConfig } from "./config-store";

/**
 * Skill secret custody UI — lives in SETTINGS (the market only installs
 * and shows status). Values go straight to the macOS keychain
 * (fez-skill-env service) via set_skill_secret and are never readable
 * back into the webview; agents resolve them at spawn in core.
 */

interface SkillConfig {
  command?: string;
  url?: string;
  env?: Record<string, string>;
}

/** Write-only keychain input. */
export function SecretField({ skill, envKey, onSaved }: { skill: string; envKey: string; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="secret-field">
      <input
        type="password"
        className="manage-input secret-input"
        placeholder={envKey}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button
        className="mini"
        disabled={busy || !value.trim()}
        title="store in the macOS keychain (write-only — the GUI can never read it back)"
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void invoke("set_skill_secret", { skill, key: envKey, value: value.trim() })
            .then(() => {
              setValue("");
              onSaved();
            })
            .catch((err) => setError(String(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "…" : "🔒 save"}
      </button>
      {error && <span className="ob-error">{error}</span>}
    </span>
  );
}

/** Env key with keychain status; editable only where custody lives (settings). */
export function EnvKeyStatus({
  skill,
  envKey,
  plaintext,
  editable,
  onSaved,
}: {
  skill: string;
  envKey: string;
  plaintext: boolean;
  editable: boolean;
  onSaved?: (text: string) => void;
}) {
  const [inKeychain, setInKeychain] = useState<boolean>();
  useEffect(() => {
    void invoke<boolean>("has_skill_secret", { skill, key: envKey }).then(setInKeychain).catch(() => setInKeychain(false));
  }, [skill, envKey]);
  if (inKeychain === undefined) return <span className="skill-dep">{envKey} …</span>;
  if (inKeychain) return <span className="skill-dep ready" title="stored in the macOS keychain">{envKey} 🔒</span>;
  if (plaintext) return <span className="skill-dep needs-env" title="plaintext value in settings.json — save it here to move it into the keychain">{envKey} ⚠ plaintext</span>;
  if (!editable) return <span className="skill-dep needs-env" title="fill in settings (⌘,) → skills & secrets">{envKey} ○ set in settings</span>;
  return (
    <span className="skill-dep needs-env">
      <SecretField
        skill={skill}
        envKey={envKey}
        onSaved={() => {
          setInKeychain(true);
          onSaved?.(`✓ ${skill}.${envKey} stored in the keychain — agents resolve it on next spawn`);
        }}
      />
    </span>
  );
}

/**
 * Vercel-style env editor: key/value rows, add-row, and PASTE support —
 * paste a .env blob ("KEY=value" lines, quotes/export/comments handled)
 * anywhere in the editor and it splits into rows. Saving writes values
 * to the keychain (write-only) and registers new key NAMES on the
 * skill's settings entry so agents know to resolve them.
 */

function parseDotEnv(text: string): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) rows.push({ key, value });
  }
  return rows;
}

function EnvEditor({
  skill,
  config,
  onNotice,
}: {
  skill: string;
  config: SkillConfig;
  onNotice: (text: string) => void;
}) {
  const declared = Object.keys(config.env ?? {});
  const [rows, setRows] = useState<{ key: string; value: string }[]>(
    declared.length > 0 ? declared.map((key) => ({ key, value: "" })) : [{ key: "", value: "" }]
  );
  const [statuses, setStatuses] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Record<number, boolean>>({});

  useEffect(() => {
    void (async () => {
      const next: Record<string, boolean> = {};
      for (const key of declared) {
        next[key] = await invoke<boolean>("has_skill_secret", { skill, key }).catch(() => false);
      }
      setStatuses(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, declared.join(",")]);

  const setRow = (index: number, patch: Partial<{ key: string; value: string }>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const handlePaste = (index: number, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    const parsed = parseDotEnv(text);
    if (parsed.length === 0) return; // ordinary paste (a bare value) — let it through
    e.preventDefault();
    setRows((prev) => {
      const next = [...prev];
      // fill from the pasted blob starting at this row; append extras
      parsed.forEach((entry, offset) => {
        const at = index + offset;
        if (at < next.length && !next[at].key && !next[at].value) next[at] = entry;
        else if (at < next.length && next[at].key === entry.key) next[at] = entry;
        else next.push(entry);
      });
      return next;
    });
  };

  const saveAll = async () => {
    setBusy(true);
    let saved = 0;
    const newNames: string[] = [];
    try {
      for (const { key, value } of rows) {
        if (!key.trim() || !value.trim()) continue;
        await invoke("set_skill_secret", { skill, key: key.trim(), value: value.trim() });
        saved++;
        if (!declared.includes(key.trim())) newNames.push(key.trim());
      }
      if (newNames.length > 0) {
        const nextConfig = { ...config, env: { ...(config.env ?? {}), ...Object.fromEntries(newNames.map((k) => [k, ""])) } };
        await invoke("write_skill", { name: skill, configJson: JSON.stringify(nextConfig) });
      }
      if (saved > 0) {
        onNotice(`✓ ${saved} secret${saved === 1 ? "" : "s"} for ${skill} → keychain (agents pick them up on next spawn)`);
        setRows((prev) => prev.map((row) => ({ ...row, value: "" })));
        setShown({});
        setStatuses((prev) => ({ ...prev, ...Object.fromEntries(rows.filter((r) => r.key && r.value).map((r) => [r.key.trim(), true])) }));
      }
    } catch (err) {
      onNotice(`✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="env-editor">
      {rows.map((row, index) => (
        <div key={index} className="env-entry">
          <div className="env-field">
            <label>Key</label>
            <input
              className="env-input"
              value={row.key}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setRow(index, { key: e.target.value })}
              onPaste={(e) => handlePaste(index, e)}
            />
          </div>
          <div className="env-field">
            <label>
              Value{statuses[row.key] && <span className="env-stored" title="a value is saved in the keychain — write-only, so it can't be shown"> 🔒 stored</span>}
            </label>
            <div className="env-value-wrap">
              <input
                className="env-input"
                type={shown[index] ? "text" : "password"}
                value={row.value}
                placeholder={statuses[row.key] ? "saved (hidden) — type to replace" : ""}
                onChange={(e) => setRow(index, { value: e.target.value })}
                onPaste={(e) => handlePaste(index, e)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              {/* Reveal is local and momentary: this is what you just typed,
                  not a value read back — nothing can read the keychain. */}
              <button
                className="env-eye"
                type="button"
                title={shown[index] ? "hide" : "show what you typed"}
                onClick={() => setShown((prev) => ({ ...prev, [index]: !prev[index] }))}
              >
                {shown[index] ? "◎" : "◉"}
              </button>
            </div>
          </div>
          {rows.length > 1 && (
            <button
              className="env-remove"
              type="button"
              title="remove"
              onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button className="env-add" type="button" onClick={() => setRows((prev) => [...prev, { key: "", value: "" }])}>
        + Add Another
      </button>
      <div className="env-footer">
        <span className="env-footer-hint">or paste .env contents in a Key field</span>
        <button
          className="env-save"
          disabled={busy || !rows.some((r) => r.key.trim() && r.value.trim())}
          onClick={() => void saveAll()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** The settings section: every installed skill's env keys, editable. */
/**
 * fez's own service keys — the ONE home for secrets the fez services
 * read (the orchestrator's router bearer key, and whatever else lands
 * here). Always shown, even with no skills installed, so there is a
 * single place to put a key. The keychain account is `fez.<VAR>`, which
 * the CLI bridges into the environment at startup (see src/cli.ts), so a
 * key set here reaches the orchestrator whether it runs from the app or
 * the terminal.
 */
const FEZ_SERVICE_KEYS: SkillConfig = { env: { FEZ_ORCHESTRATOR_KEY: "" } };

export function SkillSecretsSection({ onNotice }: { onNotice: (text: string) => void }) {
  // One reactive source: the config store re-reads settings.json whenever an
  // extension is installed/removed, so a skill's row appears here live.
  const skills = Object.entries(useConfig().skills as Record<string, SkillConfig>);
  return (
    <>
      {/* Where secrets live is the page head's line now; what survives
          here is the part that changes how you USE the fields. */}
      <div className="settings-hint">
        Paste a whole .env blob into any field and it splits into rows. Agents and services pick up new
        values on their next spawn.
      </div>
      <div className="env-skill">
        <div className="manage-section">fez — service keys</div>
        <EnvEditor skill="fez" config={FEZ_SERVICE_KEYS} onNotice={onNotice} />
      </div>
      {skills.length === 0 ? (
        <div className="settings-hint">Install a skill and its own secrets appear here too.</div>
      ) : (
        skills.map(([skill, config]) => (
          <div key={skill} className="env-skill">
            <div className="manage-section">{skill}</div>
            <EnvEditor skill={skill} config={config} onNotice={onNotice} />
          </div>
        ))
      )}
    </>
  );
}
