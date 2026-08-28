import { useMemo, useState } from "react";
import { machineLocalPath, resolveInstalledSkill } from "@fezchat/client";
import { useConfig } from "./config-store";

/**
 * Pick an agent's skills from what this machine actually has.
 *
 * Replaces a free-text box that required typing a settings.json key from
 * memory — the reason @deployer asks for a "docker" nobody installed.
 * Standalone by design: an agent-creation flow should be able to drop
 * this in unchanged.
 *
 * The list is split by what the reader came to find out. An agent's own
 * state — what is broken, what it has — is always open, because that is
 * the answer to "what is this agent". The machine's catalogue is a
 * different question ("give it something new"), it grows without bound
 * as the marketplace fills, and it stays closed until asked for: eleven
 * skills already pushed the prompt field off the pane, and fifty would
 * bury the form.
 */
interface Row {
  name: string;
  description?: string;
  source?: string;
  local: boolean;
  missing: boolean;
}

/** Past this many, scanning the catalogue by eye stops working. */
const FILTER_AT = 12;

export default function SkillPicker({
  value,
  sources,
  onChange,
}: {
  value: string[];
  sources: Record<string, string>;
  onChange: (names: string[], sources: Record<string, string>) => void;
}) {
  const { skills } = useConfig();
  const [query, setQuery] = useState("");

  // Installed skills, plus anything the persona names that isn't a
  // catalog key — a dead reference must stay VISIBLE and removable, not
  // silently vanish from the list that is supposed to explain the agent.
  //
  // Whether such a row is actually DEAD is the resolver's call, not a
  // key lookup's: `wallet=npm:@fezchat/wallet` on a machine that keyed
  // that package "fez-wallet" resolves fine and the agent spawns with
  // it, so striking it through as "not installed" made this editor
  // contradict the spawn path.
  const { broken, attached, available } = useMemo(() => {
    const installed: Row[] = Object.entries(skills).map(([name, config]) => ({
      name,
      description: config.description,
      source: config.source,
      local: !!machineLocalPath(config),
      missing: false,
    }));
    const known = new Set(installed.map((r) => r.name));
    const declared: Row[] = value
      .filter((name) => !known.has(name))
      .map((name) => {
        const hit = resolveInstalledSkill(skills, { name, source: sources[name] });
        return {
          name,
          description: hit?.entry.description,
          source: sources[name] ?? hit?.entry.source,
          local: !!machineLocalPath(hit?.entry),
          missing: !hit,
        };
      });
    const all = [...installed, ...declared].sort((a, b) => a.name.localeCompare(b.name));
    return {
      broken: all.filter((r) => r.missing),
      attached: all.filter((r) => !r.missing && value.includes(r.name)),
      available: all.filter((r) => !r.missing && !value.includes(r.name)),
    };
  }, [skills, value, sources]);

  const toggle = (name: string, source: string | undefined, on: boolean) => {
    if (on) {
      onChange([...value, name], source ? { ...sources, [name]: source } : sources);
    } else {
      const { [name]: _dropped, ...rest } = sources;
      onChange(
        value.filter((n) => n !== name),
        rest
      );
    }
  };

  const row = (r: Row) => (
    <label key={r.name} className={r.missing ? "skill-pick missing" : "skill-pick"}>
      <input
        type="checkbox"
        checked={value.includes(r.name)}
        onChange={(e) => toggle(r.name, r.source, e.target.checked)}
      />
      <span className="skill-pick-name">{r.name}</span>
      {r.description && <span className="skill-pick-desc">{r.description}</span>}
      {r.missing && <span className="role-tag missing-tag">not installed</span>}
      {r.local && (
        <span
          className="role-tag"
          title="points into a local directory — won't work on another machine"
        >
          local
        </span>
      )}
    </label>
  );

  if (broken.length + attached.length + available.length === 0) {
    return <div className="settings-hint">No skills installed yet — find some in the Skills tab.</div>;
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? available.filter(
        (r) => r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)
      )
    : available;

  return (
    <div className="skill-picker">
      {broken.length > 0 && (
        <>
          <div className="skill-pick-heading">declared, but not installed here</div>
          {broken.map(row)}
        </>
      )}

      {attached.length > 0 && (
        <>
          <div className="skill-pick-heading">attached</div>
          {attached.map(row)}
        </>
      )}

      {broken.length === 0 && attached.length === 0 && (
        <div className="settings-hint">No skills yet — open the list below to give it one.</div>
      )}

      {available.length > 0 && (
        <details className="skill-pick-more">
          <summary className="skill-pick-heading">
            available on this machine ({available.length})
          </summary>
          {available.length > FILTER_AT && (
            <input
              className="manage-input skill-pick-filter"
              value={query}
              placeholder="filter"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {shown.length === 0 ? (
            <div className="settings-hint">Nothing matches “{query}”.</div>
          ) : (
            shown.map(row)
          )}
        </details>
      )}
    </div>
  );
}
