import { useMemo } from "react";
import { machineLocalPath, resolveInstalledSkill } from "@fezchat/client";
import { useConfig } from "./config-store";

/**
 * Pick an agent's skills from what this machine actually has.
 *
 * Replaces a free-text box that required typing a settings.json key from
 * memory — the reason @deployer asks for a "docker" nobody installed.
 * Standalone by design: an agent-creation flow should be able to drop
 * this in unchanged.
 */
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

  // Installed skills, plus anything the persona names that isn't a
  // catalog key — a dead reference must stay VISIBLE and removable, not
  // silently vanish from the list that is supposed to explain the agent.
  //
  // Whether such a row is actually DEAD is the resolver's call, not a
  // key lookup's: `wallet=npm:@fezchat/wallet` on a machine that keyed
  // that package "fez-wallet" resolves fine and the agent spawns with
  // it, so striking it through as "not installed" made this editor
  // contradict the spawn path.
  const rows = useMemo(() => {
    const installed = Object.entries(skills).map(([name, config]) => ({
      name,
      description: config.description,
      source: config.source,
      local: !!machineLocalPath(config),
      missing: false,
    }));
    const known = new Set(installed.map((r) => r.name));
    const declared = value
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
    return [...installed, ...declared].sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, value, sources]);

  const toggle = (name: string, source: string | undefined, on: boolean) => {
    if (on) {
      onChange([...value, name], source ? { ...sources, [name]: source } : sources);
    } else {
      const { [name]: _dropped, ...rest } = sources;
      onChange(value.filter((n) => n !== name), rest);
    }
  };

  if (rows.length === 0) {
    return <div className="settings-hint">No skills installed yet — find some in the Skills tab.</div>;
  }

  return (
    <div className="skill-picker">
      {rows.map((row) => {
        const checked = value.includes(row.name);
        return (
          <label key={row.name} className={row.missing ? "skill-pick missing" : "skill-pick"}>
            <input type="checkbox" checked={checked} onChange={(e) => toggle(row.name, row.source, e.target.checked)} />
            <span className="skill-pick-name">{row.name}</span>
            {row.description && <span className="skill-pick-desc">{row.description}</span>}
            {row.missing && <span className="role-tag missing-tag">not installed</span>}
            {row.local && <span className="role-tag" title="points into a local directory — won't work on another machine">local</span>}
          </label>
        );
      })}
      <div className="settings-hint">Applies on next spawn — a running agent keeps the skills it started with.</div>
    </div>
  );
}
