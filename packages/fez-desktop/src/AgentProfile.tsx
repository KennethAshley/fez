import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { verifyEvent } from "nostr-tools/pure";
import { parseSkillDecls } from "@fezchat/client";
import Avatar from "./Avatar";
import { hasFace } from "./agent-face";
import { agentSkillStrip, type InstalledSkillMd } from "./agent-skill-health";
import { useConfig } from "./config-store";
import { BAZAAR_RELAY, aggregateRecord, type AttestationEvent, type RecordRow } from "./bazaar-record";
import { RelayConnection } from "../../../src/protocol/relay.js";

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

/**
 * The bazaar track record — a one-shot read per profile open, cached for
 * the session so reopening the same agent's profile doesn't re-hit the
 * relay. Kept module-level (not in a hook) because the cache should
 * outlive any single AgentProfile mount.
 */
const recordCache = new Map<string, RecordRow[] | "error">();

async function fetchRecord(pk: string): Promise<RecordRow[] | "error"> {
  const hit = recordCache.get(pk);
  if (hit) return hit;
  const relay = new RelayConnection({ urls: [BAZAAR_RELAY] });
  try {
    await relay.connect();
    const events = (await relay.query([{ kinds: [47020], "#p": [pk], limit: 500 }])) as unknown as AttestationEvent[];
    // connect()/query() never reject on a dead relay — connect() swallows
    // failures into onError (Promise.allSettled) and query()'s querySync
    // just resolves empty once its wait window elapses. So an unreachable
    // relay and a reachable-but-empty relay would otherwise both land here
    // with events = []. health() is the only thing that tells them apart:
    // if nothing ever connected, this is "unknown", not "no record".
    if (!relay.health().some((h) => h.connected)) throw new Error("bazaar relay unreachable");
    const rows = aggregateRecord(events.filter((ev) => verifyEvent(ev as never)), pk);
    recordCache.set(pk, rows);
    return rows;
  } catch {
    recordCache.set(pk, "error");
    return "error";
  } finally {
    relay.disconnect();
  }
}

/**
 * Three states, and the error state must never collapse into "empty" —
 * a relay that's unreachable tells you nothing about whether the agent
 * has a record, so it gets its own sentence (same rule as the wallet's
 * mirror states).
 */
function TrackRecord({ pk }: { pk: string }) {
  const [rows, setRows] = useState<RecordRow[] | "error">();

  useEffect(() => {
    let cancelled = false;
    setRows(undefined);
    void fetchRecord(pk).then((r) => {
      if (!cancelled) setRows(r);
    });
    return () => {
      cancelled = true;
    };
  }, [pk]);

  if (rows === undefined) return <div className="settings-hint">◌ checking the bazaar…</div>;
  if (rows === "error") return <div className="settings-hint">bazaar relay unreachable — record unknown, not empty</div>;
  if (rows.length === 0) return <div className="settings-hint">no public record yet — this agent hasn't worked the bazaar</div>;
  return (
    <ul className="profile-skills">
      {rows.map((r) => (
        <li key={r.taskType}>
          <b>{r.taskType}</b>
          <span className="skill-desc">
            {" "}
            · {r.count} scored task{r.count === 1 ? "" : "s"}
            {r.percentile !== undefined ? ` · ${r.percentile}th percentile` : ""}
            {` · last active ${new Date(r.lastAt * 1000).toLocaleDateString()}`}
          </span>
        </li>
      ))}
    </ul>
  );
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

        <div className="manage-section">track record</div>
        {pk ? <TrackRecord pk={pk} /> : <div className="settings-hint">no public key — record unknowable</div>}

        <div className="manage-section">runtime</div>
        <dl className="profile-facts">
          <dt>body</dt>
          <dd className="mono">
            <RestartRow name={name} />
          </dd>
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

/**
 * The manual bounce. Tools and brain keys bake in at spawn, so "restart"
 * is how a running body picks up anything it was born before — and the
 * escape hatch when an agent is just being weird. The body is disposable
 * by design: identity and memory live on the relay, and the next mention
 * respawns it against the persona as it stands now.
 */
function RestartRow({ name }: { name: string }) {
  const [alive, setAlive] = useState<boolean>();
  const [done, setDone] = useState(false);
  useEffect(() => {
    let live = true;
    void invoke<boolean>("agent_alive", { persona: name, bin: null })
      .then((a) => { if (live) setAlive(a); })
      .catch(() => { if (live) setAlive(false); });
    return () => { live = false; };
  }, [name, done]);
  if (alive === undefined) return <span>checking…</span>;
  if (done) return <span>restarting on next mention</span>;
  if (!alive) return <span>asleep — wakes on mention</span>;
  return (
    <button
      className="skill-link"
      title={`stop @${name}'s running body — it respawns with the current persona (tools included) on its next mention`}
      onClick={() => {
        void invoke("kill_agent", { persona: name, bin: null })
          .catch(() => {})
          .then(() => setDone(true));
      }}
    >
      running — restart
    </button>
  );
}
