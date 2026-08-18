import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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

/** The settings section: every installed skill's env keys, editable. */
export function SkillSecretsSection({ onNotice }: { onNotice: (text: string) => void }) {
  const [installed, setInstalled] = useState<Record<string, SkillConfig>>({});
  useEffect(() => {
    void invoke<string>("read_skills")
      .then((json) => setInstalled(JSON.parse(json) as Record<string, SkillConfig>))
      .catch(() => setInstalled({}));
  }, []);
  const withEnv = Object.entries(installed).filter(([, config]) => Object.keys(config.env ?? {}).length > 0);
  if (withEnv.length === 0) {
    return <div className="settings-hint">no installed skills need secrets — keys appear here when a skill declares env vars.</div>;
  }
  return (
    <>
      <div className="settings-hint">
        Secrets live in the macOS keychain, never in files — saving here is write-only (nothing can read a value
        back). Agents pick up new values on their next spawn.
      </div>
      {withEnv.map(([skill, config]) => (
        <div key={skill} className="dep-row">
          <span className="dep-agent">{skill}</span>
          <span className="dep-skills">
            {Object.keys(config.env ?? {}).map((key) => (
              <EnvKeyStatus key={key} skill={skill} envKey={key} plaintext={!!config.env?.[key]?.trim()} editable onSaved={onNotice} />
            ))}
          </span>
        </div>
      ))}
    </>
  );
}
