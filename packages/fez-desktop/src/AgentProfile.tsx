import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseSkillDecls } from "@fezchat/client";
import Avatar from "./Avatar";
import { hasFace } from "./agent-face";
import { agentSkillStrip, type InstalledSkillMd } from "./agent-skill-health";
import { useConfig } from "./config-store";

/**
 * One agent, at reading size.
 *
 * Clicking an agent used to drop you straight into a twelve-field form.
 * A form is for changing something; you usually open an agent to find
 * out what it is. So this answers that first — who it is, what it can
 * do, and whether any of it is broken — and edit is a mode you choose.
 *
 * Sections are label + hairline, the same rule the rest of the app
 * follows. Machine facts (harness, key, package ids) set in mono; the
 * agent's own words do not.
 */
function field(front: string, key: string): string | undefined {
  return front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

export default function AgentProfile({
  name,
  pk,
  online,
  onEdit,
  onMessage,
}: {
  name: string;
  pk?: string;
  online?: boolean;
  onEdit: () => void;
  onMessage?: () => void;
}) {
  const { skills: catalog } = useConfig();
  const [content, setContent] = useState<string>();
  const [installedMds, setInstalledMds] = useState<InstalledSkillMd[]>([]);

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("read_persona", { name })
      .catch(() => "")
      .then((c) => {
        if (!cancelled) setContent(c);
      });
    void invoke<string>("list_installed_skills")
      .then((raw) => {
        if (!cancelled) setInstalledMds(JSON.parse(raw));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [name]);

  const faced = hasFace(name, pk);
  const skills = content ? agentSkillStrip(content, catalog) : [];
  // The skills: line resolved against what's installed — each row's
  // description is a routing sentence ("Use when…"), which is exactly
  // the "what do I ping it for" a reader opened this profile to learn.
  const skillLine = content?.match(/^skills:\s*(.+)$/m)?.[1]?.replace(/^\[|\]$/g, "") ?? "";
  const packDecls = parseSkillDecls(skillLine.split(",").map((s) => s.trim()).filter(Boolean));
  const packSkills = packDecls.names.map((n) => {
    const hit = installedMds.find((s) => s.id === n || s.name === n);
    return { key: n, name: hit?.name ?? n, description: hit?.description, setting: packDecls.settings[n], missing: !hit };
  });
  const description = content ? field(content, "description") : undefined;
  const harness = content ? field(content, "harness") : undefined;
  const channels = content ? field(content, "channels") : undefined;
  const access = content ? field(content, "respondTo") : undefined;

  return (
    <div className="pane-body">
        <div className="profile-id">
          <span className={online ? "profile-face online" : "profile-face"}>
            {faced ? (
              <Avatar pk={pk ?? ""} title={name} size={96} />
            ) : (
              <span className="agent-egg big" aria-hidden>
                ◌
              </span>
            )}
          </span>
          <div className="profile-name">@{name}</div>
          {description && <div className="profile-desc">{description}</div>}
        </div>

        <div className="profile-actions">
          {onMessage && (
            <button className="agent-action" onClick={onMessage}>
              message
            </button>
          )}
          <button className="agent-action" onClick={onEdit}>
            edit
          </button>
        </div>

        <div className="manage-section">skills</div>
        {packSkills.length === 0 ? (
          <div className="settings-hint">No skills attached. Add packs in edit — or DM @fez a GitHub link to install more.</div>
        ) : (
          <ul className="profile-skills">
            {packSkills.map((s) => (
              <li key={s.key} className="profile-skill">
                <span className={s.missing ? "skill-chip missing" : "skill-chip"}>
                  {s.name}
                  {s.setting ? ` (${s.setting})` : ""}
                </span>
                <span className="profile-skill-state">
                  {s.missing ? "not installed here" : s.description}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="manage-section">tools</div>
        {skills.length === 0 ? (
          <div className="settings-hint">
            No tools. Give it one from the tools tab, or in edit.
          </div>
        ) : (
          <ul className="profile-skills">
            {skills.map((skill) => (
              <li key={skill.name} className="profile-skill">
                <span
                  className={
                    skill.missing
                      ? "skill-chip missing"
                      : skill.local
                        ? "skill-chip local"
                        : "skill-chip"
                  }
                >
                  {skill.name}
                </span>
                <span className="profile-skill-state">
                  {skill.missing
                    ? "not installed here"
                    : skill.local
                      ? "works on this machine only"
                      : "ready"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="manage-section">runtime</div>
        <dl className="profile-facts">
          <dt>harness</dt>
          <dd className="mono">{harness ?? "—"}</dd>
          <dt>channels</dt>
          <dd className="mono">{channels ?? "any it is mentioned in"}</dd>
          <dt>access</dt>
          <dd className="mono">{access ?? "owner"}</dd>
          <dt>key</dt>
          <dd className="mono">
            {pk ? `${pk.slice(0, 8)}…${pk.slice(-4)}` : "not yet minted — appears on first spawn"}
          </dd>
        </dl>
    </div>
  );
}
