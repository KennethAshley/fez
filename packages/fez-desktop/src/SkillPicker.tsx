import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { machineLocalPath, resolveInstalledSkill } from "@fezchat/client";
import { useConfig } from "./config-store";
import type { InstalledSkillMd } from "./agent-skill-health";

/**
 * Pick an agent's skills from what this machine actually has.
 *
 * Replaces a free-text box that required typing a settings.json key from
 * memory — the reason @deployer asks for a "docker" nobody installed.
 * Standalone by design: an agent-creation flow should be able to drop
 * this in unchanged.
 *
 * Two different questions, two different shapes. What this agent CARRIES
 * is an inventory — you already know what web-search does, so it reads as
 * chips you can drop, four to a pane-width instead of one per line. What
 * this MACHINE has is a catalogue you shop from: it needs descriptions,
 * it grows without bound as the marketplace fills, and it stays behind a
 * disclosure with its own scroll — eleven skills rendered as rows once
 * pushed the prompt clean off the pane, and fifty would bury the form.
 */
interface Row {
  name: string;
  description?: string;
  source?: string;
  local: boolean;
  missing: boolean;
}

/** Past this many, scanning the catalogue by eye stops working. */
const FILTER_AT = 8;

export default function SkillPicker({
  value,
  sources,
  onChange,
  skillsValue,
  onSkillsChange,
}: {
  value: string[];
  sources: Record<string, string>;
  onChange: (names: string[], sources: Record<string, string>) => void;
  /** SKILL.md packs this persona attaches — the `skills:` key, separate
      catalog and separate frontmatter line from the mcpServers tools below. */
  skillsValue: string[];
  onSkillsChange: (names: string[]) => void;
}) {
  const { skills } = useConfig();
  const [query, setQuery] = useState("");
  const [installedSkillMds, setInstalledSkillMds] = useState<InstalledSkillMd[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<string>("list_installed_skills")
      .then((raw) => {
        if (!cancelled) setInstalledSkillMds(JSON.parse(raw));
      })
      .catch(() => {
        if (!cancelled) setInstalledSkillMds([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Matched by id OR name — the same rule agentSkillHealth and spawn-time
  // resolveAttachedSkills (fez-acp/skills-prompt.ts) use, so a persona
  // declaring the canonical `id` reads as installed here too, instead of
  // showing a bogus "missing" row alongside a duplicate unchecked one.
  //
  // `declaredAs` carries the EXACT string already in the persona (id or
  // name, whichever it happens to be) so toggling off never rewrites an
  // identifier that's already there — only a fresh attach picks one, and
  // it always picks `id` (see toggleSkillMd).
  //
  // Same "declared but not in the catalog stays visible" rule as the
  // tools rows below — a dead skill name must stay removable, not vanish.
  const skillMdRows = useMemo(() => {
    const catalog = installedSkillMds.map((s) => ({
      key: s.id,
      name: s.name,
      description: s.description as string | undefined,
      missing: false,
      declaredAs: skillsValue.find((v) => v === s.id || v === s.name),
    }));
    const missing = skillsValue
      .filter((v) => !installedSkillMds.some((s) => s.id === v || s.name === v))
      .map((v) => ({ key: v, name: v, description: undefined as string | undefined, missing: true, declaredAs: v }));
    return [...catalog, ...missing].sort((a, b) => a.name.localeCompare(b.name));
  }, [installedSkillMds, skillsValue]);

  const toggleSkillMd = (row: { key: string; declaredAs?: string }, on: boolean) => {
    // New attaches write `id` (the identifier install produces); an
    // existing declaration is only ever removed, never rewritten, so
    // whichever identifier the persona already used survives untouched.
    onSkillsChange(on ? [...skillsValue, row.key] : skillsValue.filter((v) => v !== row.declaredAs));
  };

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

  /** Carried: a thing the agent has, and the one action is to take it away.
      Same chip the agent card and profile draw — `editable` only adds the
      drop button — so a skill looks like itself everywhere it is named. */
  const chip = (r: Row) => (
    <span
      key={r.name}
      className={`skill-chip editable${r.missing ? " missing" : r.local ? " local" : ""}`}
      title={r.description}
    >
      {r.name}
      <button
        type="button"
        className="skill-chip-drop"
        aria-label={`remove ${r.name}`}
        onClick={() => toggle(r.name, r.source, false)}
      >
        ×
      </button>
    </span>
  );

  /** Catalogue: a thing you are deciding about, so it keeps its description. */
  const row = (r: Row) => (
    <label key={r.name} className="skill-pick">
      <input
        type="checkbox"
        checked={value.includes(r.name)}
        onChange={(e) => toggle(r.name, r.source, e.target.checked)}
      />
      <span className="skill-pick-text">
        <span className="skill-pick-name">{r.name}</span>
        {r.description && <span className="skill-pick-desc">{r.description}</span>}
      </span>
      {r.local && (
        <span className="skill-pick-mark" title="points into a local directory — won't work on another machine">
          ·local
        </span>
      )}
    </label>
  );

  const skillMdRow = (r: { key: string; name: string; description?: string; missing: boolean; declaredAs?: string }) => (
    <label key={r.key} className={`skill-pick${r.missing ? " missing" : ""}`}>
      <input
        type="checkbox"
        checked={r.declaredAs !== undefined}
        onChange={(e) => toggleSkillMd(r, e.target.checked)}
      />
      <span className="skill-pick-text">
        <span className="skill-pick-name">{r.name}</span>
        <span className="skill-pick-desc">
          {r.missing ? "— install it from chat or ⊞ extensions" : r.description && `— ${r.description}`}
        </span>
      </span>
    </label>
  );

  const skillMdSection = skillMdRows.length > 0 && (
    <div className="skill-pick-list">{skillMdRows.map(skillMdRow)}</div>
  );

  if (broken.length + attached.length + available.length === 0) {
    return (
      <>
        {skillMdSection}
        <div className="settings-hint">No tools installed yet — find some in the tools tab.</div>
      </>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? available.filter(
        (r) => r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)
      )
    : available;

  return (
    <div className="skill-picker">
      {skillMdSection}
      {broken.length > 0 && (
        <div className="skill-broken">
          <div className="skill-broken-head">declared, but not installed here</div>
          <div className="skill-strip left">{broken.map(chip)}</div>
          <div className="field-note">This agent spawns without them until you install them in the tools tab.</div>
        </div>
      )}

      {attached.length > 0 ? (
        <>
          {/* Only when the broken block is above it: on its own, the chips
              ARE the answer to "skills" and a label just repeats it. */}
          {broken.length > 0 && <div className="skill-carried-head">carried</div>}
          <div className="skill-strip left">{attached.map(chip)}</div>
        </>
      ) : (
        broken.length === 0 && (
          <div className="skill-empty">
            Carries nothing yet — it can still talk, it just can't touch anything.
          </div>
        )
      )}

      {available.length > 0 && (
        <details className="skill-pick-more">
          <summary>
            <span className="skill-pick-more-label">add a skill</span>
            <span className="skill-pick-more-count">{available.length} on this machine</span>
          </summary>
          <div className="skill-pick-drawer">
            {available.length > FILTER_AT && (
              <input
                className="manage-input skill-pick-filter"
                value={query}
                placeholder="filter"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div className="skill-pick-list">
              {shown.length === 0 ? <div className="settings-hint">Nothing matches “{query}”.</div> : shown.map(row)}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
