import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConfig } from "./config-store";
import { PROVIDERS } from "./providers";

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
  /** "oauth" — a sign-in connection (Connections), not a pasted key. */
  auth?: string;
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
        aria-label={`${skill} ${envKey}`}
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
  statuses,
  onStatuses,
  onNotice,
}: {
  skill: string;
  config: SkillConfig;
  /** Keychain state per key — owned by the card so the header chips share it. */
  statuses: Record<string, boolean>;
  onStatuses: (patch: Record<string, boolean>) => void;
  onNotice: (text: string) => void;
}) {
  const declared = Object.keys(config.env ?? {});
  const [rows, setRows] = useState<{ key: string; value: string }[]>(
    declared.length > 0 ? declared.map((key) => ({ key, value: "" })) : [{ key: "", value: "" }]
  );
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Record<number, boolean>>({});

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
        onStatuses(Object.fromEntries(rows.filter((r) => r.key && r.value).map((r) => [r.key.trim(), true])));
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
// TYPESAFE_API_KEY is the room's judgment (Jev): with it, routing, acceptance,
// and attention calls go to TypeSafe directly and no fez server is involved.
const FEZ_SERVICE_KEYS: SkillConfig = { env: { TYPESAFE_API_KEY: "", FEZ_ORCHESTRATOR_KEY: "" } };

/**
 * One service, one keycard. A native <details>: the summary is the card
 * head — name, hint, and a chip per declared key showing custody state —
 * so which key belongs to which service is legible with every card
 * closed. Cards missing a key open themselves and wear the ember notch;
 * the page is a punch list that goes quiet when custody is complete.
 */
/**
 * An OAuth connection in the CUSTODY view. The token lives in the same
 * keychain as pasted keys, but it's never shown — it rotates on refresh
 * and isn't a value the human manages. So this is state, not a field:
 * connected / not, with Disconnect. Signing IN happens at the point of
 * intent (gallery, agent editor); this is where you REVOKE.
 */
function ConnectionCard({ skill, title, onNotice }: { skill: string; title: string; onNotice: (text: string) => void }) {
  const [connected, setConnected] = useState<boolean>();
  useEffect(() => {
    void invoke<boolean>("has_skill_secret", { skill, key: "OAUTH" }).then(setConnected).catch(() => setConnected(false));
  }, [skill]);
  return (
    <div className="secret-card" data-needs={connected === false ? "" : undefined}>
      <div className="secret-card-head">
        <span className="secret-card-name">{title}</span>
        <span className="secret-card-hint">signed-in connection — token held in the keychain, refreshed automatically</span>
        <span className="secret-card-keys">
          <span className={"key-chip" + (connected === undefined ? "" : connected ? " stored" : " missing")}>
            {connected === undefined ? "…" : connected ? "🔒 connected" : "○ not connected"}
          </span>
          {connected && (
            <button
              className="mini"
              title="forget this connection's tokens — the agent loses the tool until you sign in again"
              onClick={() => {
                void invoke("delete_skill_secret", { skill, key: "OAUTH" })
                  .then(() => { setConnected(false); onNotice(`✓ ${title} disconnected — tokens forgotten`); })
                  .catch((e) => onNotice(`✗ ${String(e)}`));
              }}
            >
              disconnect
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function SecretCard({
  skill,
  title,
  hint,
  config,
  onNotice,
}: {
  skill: string;
  title: string;
  hint?: string;
  config: SkillConfig;
  onNotice: (text: string) => void;
}) {
  const declared = Object.keys(config.env ?? {});
  const [statuses, setStatuses] = useState<Record<string, boolean>>();
  const [open, setOpen] = useState<boolean>();
  useEffect(() => {
    void (async () => {
      const next: Record<string, boolean> = {};
      for (const key of declared) {
        next[key] = await invoke<boolean>("has_skill_secret", { skill, key }).catch(() => false);
      }
      setStatuses(next);
      // first knowledge decides the resting state; after that it's the user's
      setOpen((prev) => prev ?? declared.some((k) => !next[k]));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, declared.join(",")]);
  const missing = statuses ? declared.filter((k) => !statuses[k]).length : 0;
  return (
    <details
      className="secret-card"
      data-needs={statuses && missing > 0 ? "" : undefined}
      open={open ?? false}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="secret-card-head">
        <span className="secret-card-name">{title}</span>
        {hint && <span className="secret-card-hint">{hint}</span>}
        <span className="secret-card-keys">
          {declared.map((k) => (
            <span
              key={k}
              className={"key-chip" + (statuses ? (statuses[k] ? " stored" : " missing") : "")}
              title={statuses?.[k] ? "stored in the macOS keychain — write-only" : "no value yet"}
            >
              {statuses?.[k] ? "🔒 " : "○ "}
              {k}
            </span>
          ))}
        </span>
      </summary>
      <div className="secret-card-body">
        <EnvEditor
          skill={skill}
          config={config}
          statuses={statuses ?? {}}
          onStatuses={(patch) => setStatuses((prev) => ({ ...(prev ?? {}), ...patch }))}
          onNotice={onNotice}
        />
      </div>
    </details>
  );
}

export function SkillSecretsSection({ onNotice }: { onNotice: (text: string) => void }) {
  // One reactive source: the config store re-reads settings.json whenever an
  // extension is installed/removed, so a skill's card appears here live.
  const skills = Object.entries(useConfig().skills as Record<string, SkillConfig>).filter(
    ([skill]) => !PROVIDERS.some((p) => p.id === skill)
  );
  return (
    <div className="secrets-page">
      {/* Where secrets live is the page head's line; what survives here is
          the part that changes how you USE the fields. */}
      <div className="settings-hint">
        Paste a whole .env blob into any Key field and it splits into rows. Agents and services pick
        up new values on their next spawn.
      </div>
      <div className="manage-section">fez</div>
      <div className="secret-grid">
        <SecretCard
          skill="fez"
          title="service keys"
          hint="keys fez's own services read — TYPESAFE_API_KEY is the room's judgment (who takes a mention, is a result done, what needs you; get one at typesafe.ai), FEZ_ORCHESTRATOR_KEY a hosted router's bearer"
          config={FEZ_SERVICE_KEYS}
          onNotice={onNotice}
        />
      </div>
      {/* Providers are first-class, not installed skills — their cards are
          always here, so a key has a home before anything else is set up.
          Wiring into an agent happens in the agent editor's model picker. */}
      <div className="manage-section">model providers</div>
      <div className="settings-hint">
        Add a key and the provider's models appear in every agent editor — each agent picks its own
        provider and model there.
      </div>
      <div className="secret-grid">
        {PROVIDERS.map((p) => (
          <SecretCard
            key={p.id}
            skill={p.id}
            title={p.id}
            hint={p.hint}
            config={{ env: { [p.keyName]: "", ...p.extraKeys } }}
            onNotice={onNotice}
          />
        ))}
      </div>
      <div className="manage-section">installed skills</div>
      {skills.length === 0 ? (
        <div className="settings-hint">
          Install an extension and its skill gets a card here — add the key once, and every agent
          you attach the skill to can use it.
        </div>
      ) : (
        <div className="secret-grid">
          {skills.map(([skill, config]) =>
            config.auth === "oauth" ? (
              <ConnectionCard key={skill} skill={skill} title={skill} onNotice={onNotice} />
            ) : (
              <SecretCard key={skill} skill={skill} title={skill} config={config} onNotice={onNotice} />
            )
          )}
        </div>
      )}
    </div>
  );
}
