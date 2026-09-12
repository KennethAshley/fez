import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { verifyEvent } from "nostr-tools/pure";
import { parseSkillDecls } from "@fezchat/client";
import Avatar from "./Avatar";
import { hasFace } from "./agent-face";
import { agentSkillStrip, type InstalledSkillMd } from "./agent-skill-health";
import { useConfig } from "./config-store";
import { relaySet } from "./relay";
import { markWaking, clearWaking, wakingSince, wakeLabel, subscribeWaking } from "./waking";
import { BAZAAR_RELAY, aggregateRecord, bestRow, type AttestationEvent, type RecordRow } from "./bazaar-record";
import { fetchSaltPanel, tierLabel, type SaltPanel } from "./salt-record";
import { SaltSection, AgentProfileExtras } from "./AgentReputation";
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
    // NOT cached: "unreachable" pinned for the whole session meant
    // reconnecting and reopening the profile still said unreachable.
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
function TrackRecord({ rows }: { rows: RecordRow[] | "error" | undefined }) {
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
  owner,
  onEdit,
  onMessage,
  viewer,
  isViewerAgent,
  inViewerCircle,
  displayName,
}: {
  name: string;
  pk?: string;
  online?: boolean;
  /** The workspace owner's pubkey — what start/restart spawns under. */
  owner?: string;
  onEdit: () => void;
  onMessage?: () => void;
  /** The reader's pubkey — salt is bucketed by the viewer's vantage. */
  viewer?: string;
  isViewerAgent?: (pk: string) => boolean;
  inViewerCircle?: (pk: string) => boolean;
  displayName?: (pk: string) => string;
}) {
  const { skills: catalog } = useConfig();
  const [content, setContent] = useState<string>();
  const [installedMds, setInstalledMds] = useState<InstalledSkillMd[]>([]);
  // Standing data lives here, not in the sections: the header strip and
  // the standing section read the same fetch, so one relay round-trip
  // feeds both the glance and the detail.
  const [record, setRecord] = useState<RecordRow[] | "error">();
  const [salt, setSalt] = useState<SaltPanel | "error">();

  useEffect(() => {
    let cancelled = false;
    setRecord(undefined);
    setSalt(undefined);
    if (!pk) return;
    void fetchRecord(pk).then((r) => {
      if (!cancelled) setRecord(r);
    });
    if (viewer) {
      void fetchSaltPanel({
        pk,
        viewer,
        relays: [...relaySet(), BAZAAR_RELAY],
        isViewerAgent: isViewerAgent ?? ((k) => k === viewer),
        inViewerCircle: inViewerCircle ?? (() => false),
      })
        .then((p) => { if (!cancelled) setSalt(p); })
        .catch(() => { if (!cancelled) setSalt("error"); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pk, viewer]);

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
          <span
            className={online ? "profile-face online" : "profile-face"}
            title={online ? "seen on the relay" : undefined}
          >
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
          {/* The glance: standing and body compressed to chips, so a
              reader who never scrolls still knows how this agent is
              judged and what runs it. Ember bar = the tier that needs
              you; online already lives on the face's dot. */}
          {(salt || record || harness) && (
            <div className="profile-strip">
              {typeof record === "object" && bestRow(record) ? (
                <span className="skill-chip" title="strongest suit on the bazaar — judged, scored work">
                  {(() => {
                    const b = bestRow(record)!;
                    return `${b.taskType}${b.percentile !== undefined ? ` · ${b.percentile}th` : ` · ${b.count} task${b.count === 1 ? "" : "s"}`}`;
                  })()}
                </span>
              ) : null}
              {salt && salt !== "error" ? (
                <span
                  className={salt.tier === "nameless" || salt.tier === "spoken-of" ? "skill-chip attn" : "skill-chip"}
                  title="peer standing from your vantage — details under standing"
                >
                  {tierLabel(salt.tier)}
                </span>
              ) : null}
              {harness ? <span className="skill-chip" title="what runs it — details under runtime">{harness}</span> : null}
            </div>
          )}
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

        <div className="manage-section">
          capabilities
          {packSkills.length + skills.length > 0 ? (
            <span className="section-fact">
              {[
                packSkills.length ? `${packSkills.length} pack${packSkills.length === 1 ? "" : "s"}` : "",
                skills.length ? `${skills.length} tool${skills.length === 1 ? "" : "s"}` : "",
              ].filter(Boolean).join(" + ")}
            </span>
          ) : null}
        </div>
        <div className="manage-sub">skill packs</div>
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

        <div className="manage-sub">tools</div>
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

        {/* Two evidence systems, one question — "is it any good?" —
            so they share a section: judged bazaar scores first (dense,
            scored), peer salt beneath. */}
        <div className="manage-section">standing</div>
        <div className="manage-sub">bazaar grades</div>
        {pk ? <TrackRecord rows={record} /> : <div className="settings-hint">no public key — record unknowable</div>}
        {pk && viewer ? (
          <SaltSection panel={salt} viewer={viewer} displayName={displayName} />
        ) : (
          <div className="settings-hint">no public key — salt unknowable</div>
        )}

        {pk && <AgentProfileExtras pubkey={pk} persona={name} />}

        <div className="manage-section">runtime</div>
        <dl className="profile-facts">
          <dt>status</dt>
          <dd className="mono">
            <RestartRow name={name} owner={owner} online={online} />
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
 * The manual bounce, as state + verb. Tools and brain keys bake in at
 * spawn, so restart is how a running body picks up anything it was born
 * before — and start is the same act from asleep. Both go through the
 * native spawn_agent replacement with the registry's channels/work,
 * so the button does the thing NOW instead of
 * describing what a future mention would do. Without an owner pubkey
 * there is nothing to spawn under, so the row degrades to the old
 * wakes-on-mention prose rather than a button that can't deliver.
 */
function RestartRow({ name, owner, online }: { name: string; owner?: string; online?: boolean }) {
  const [alive, setAlive] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The one moment the restart button matters: the persona was edited
  // AFTER this body spawned, so the running process is behind the file.
  const [spawnedAt, setSpawnedAt] = useState<number>();
  const [personaMtime, setPersonaMtime] = useState<number>();
  // A persona with no registry row has never been started — "asleep"
  // reads as a fault for something that simply hasn't happened yet.
  const [everStarted, setEverStarted] = useState(true);
  useEffect(() => {
    let live = true;
    void invoke<boolean>("agent_alive", { persona: name, bin: "fez-agent" })
      .then((a) => { if (live) setAlive(a); })
      .catch(() => { if (live) setAlive(false); });
    void invoke<{ persona: string; bin?: string; spawned_at?: number }[]>("spawned_agents")
      .then((rows) => {
        if (!live) return;
        const row = rows.find((r) => r.persona === name && (r.bin ?? "fez-agent") === "fez-agent");
        setEverStarted(!!row);
        setSpawnedAt(row?.spawned_at);
      })
      .catch(() => {});
    void invoke<number>("persona_mtime", { name })
      .then((m) => { if (live) setPersonaMtime(m); })
      .catch(() => {});
    return () => { live = false; };
  }, [name, busy]);

  // The waking window: re-draw as it ages (the stall message is time-
  // based), stop the moment the agent announces or something clears it
  // (the death toast does, so the row never claims a corpse is waking).
  const [, tick] = useState(0);
  useEffect(() => {
    if (online) clearWaking(name);
    const unsub = subscribeWaking(() => tick((n) => n + 1));
    const timer = wakingSince(name) !== undefined ? setInterval(() => tick((n) => n + 1), 1000) : undefined;
    return () => { unsub(); if (timer) clearInterval(timer); };
  }, [name, online, busy]);

  const bounce = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const rows = await invoke<{ persona: string; bin?: string; channels: string[]; repo?: string; line?: string }[]>("spawned_agents").catch(() => []);
      const row = rows.find((r) => r.persona === name && (r.bin ?? "fez-agent") === "fez-agent");
      const pid = await invoke<number>("spawn_agent", {
        persona: name,
        channels: row?.channels ?? [],
        owner,
        relays: relaySet().join(","),
        repo: row?.repo ?? null,
        baseBranch: row?.line ?? null,
        manual: true,
      });
      if (pid === 0) throw new Error("The agent did not start. Update Fez and try again.");
      markWaking(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (alive === undefined) return <span>checking…</span>;
  if (busy) return <span>{alive ? "restarting…" : "starting…"}</span>;
  const verb = alive ? "restart" : "start";
  const wake = wakeLabel(name);
  const stale = alive && spawnedAt !== undefined && personaMtime !== undefined && personaMtime > spawnedAt;
  const since = alive && spawnedAt
    ? ` since ${new Date(spawnedAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : "";
  return (
    <span title="the process on this machine — the relay dot on the face is a separate truth">
      <span>
        {alive
          ? wake && !online
            ? wake.text
            : `running${since}`
          : everStarted ? "asleep" : "not started yet"}
      </span>
      {owner ? (
        <>
          {" "}
          <button
            className="skill-link"
            title={
              alive
                ? `stop @${name} and start it fresh against the persona as it stands now (tools included)`
                : `start @${name} now — same as mentioning it, without the message`
            }
            onClick={() => void bounce()}
          >
            {verb}
          </button>
        </>
      ) : (
        <span> — wakes on mention</span>
      )}
      {stale ? (
        <span style={{ color: "var(--brand, #FF6A00)" }}>
          {" "}· edited since it started — restart to pick up the changes
        </span>
      ) : null}
      {error ? <span className="ob-error"> {error}</span> : null}
    </span>
  );
}
