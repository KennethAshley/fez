import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { verifyEvent } from "nostr-tools/pure";
import { parseSkillDecls } from "@fezchat/client";
import Avatar from "./Avatar";
import { hasFace } from "./agent-face";
import { agentSkillStrip, type InstalledSkillMd } from "./agent-skill-health";
import { useConfig } from "./config-store";
import { relaySet } from "./relay";
import { BAZAAR_RELAY, aggregateRecord, type AttestationEvent, type RecordRow } from "./bazaar-record";
import { fetchSaltPanel, tierLabel, type SaltPanel } from "./salt-record";
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

/**
 * The salt panel — what people OUTSIDE the household say. For your own
 * agents the self-dealing filter excludes your chits by design: this
 * section shows what others say, which is the only part worth reading.
 */
function SaltSection({ pk, viewer, isViewerAgent, inViewerCircle }: {
  pk: string;
  viewer: string;
  isViewerAgent: (pk: string) => boolean;
  inViewerCircle: (pk: string) => boolean;
}) {
  const [panel, setPanel] = useState<SaltPanel | "error">();

  useEffect(() => {
    let cancelled = false;
    setPanel(undefined);
    void fetchSaltPanel({ pk, viewer, relays: [...relaySet(), BAZAAR_RELAY], isViewerAgent, inViewerCircle })
      .then((p) => { if (!cancelled) setPanel(p); })
      .catch(() => { if (!cancelled) setPanel("error"); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pk, viewer]);

  if (panel === undefined) return <div className="settings-hint">◌ checking for salt…</div>;
  if (panel === "error") return <div className="settings-hint">relays unreachable — salt unknown, not absent</div>;
  if (panel.tier === "nameless" && panel.ring2Signers === 0) {
    return (
      <div className="settings-hint">
        no salt — no one you can verify has attested this agent's work
        {panel.excluded > 0 ? ` (${panel.excluded} household voices excluded)` : ""}
      </div>
    );
  }
  const lines = [...panel.ring0, ...panel.ring1].slice(0, 5);
  return (
    <>
      <div className="profile-desc">{tierLabel(panel.tier)}</div>
      {lines.length > 0 && (
        <ul className="profile-skills">
          {lines.map((e, i) => (
            <li key={`${e.signer}${e.workId ?? ""}${i}`}>
              {e.note}
              <span className="skill-desc">
                {" "}— {e.signer.slice(0, 8)} · {new Date(e.at * 1000).toLocaleDateString()}
                {e.moneyBacked ? " · paid" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {panel.ring2Signers > 0 && (
        <div
          className="settings-hint"
          title="distinct keys, sybil-able — each is at least a real keypair vouching in public"
        >
          spoken of by {panel.ring2Signers} key{panel.ring2Signers === 1 ? "" : "s"}
        </div>
      )}
      {panel.excluded > 0 && (
        <div className="settings-hint">({panel.excluded} household voices excluded)</div>
      )}
    </>
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

        <div className="manage-section">salt</div>
        {pk && viewer ? (
          <SaltSection
            pk={pk}
            viewer={viewer}
            isViewerAgent={isViewerAgent ?? ((k) => k === viewer)}
            inViewerCircle={inViewerCircle ?? (() => false)}
          />
        ) : (
          <div className="settings-hint">no public key — salt unknowable</div>
        )}

        <div className="manage-section">runtime</div>
        <dl className="profile-facts">
          <dt>body</dt>
          <dd className="mono">
            <RestartRow name={name} owner={owner} />
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
 * summoner's own sequence (kill_agent, then spawn_agent with the
 * registry's channels), so the button does the thing NOW instead of
 * describing what a future mention would do. Without an owner pubkey
 * there is nothing to spawn under, so the row degrades to the old
 * wakes-on-mention prose rather than a button that can't deliver.
 */
function RestartRow({ name, owner }: { name: string; owner?: string }) {
  const [alive, setAlive] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void invoke<boolean>("agent_alive", { persona: name, bin: null })
      .then((a) => { if (live) setAlive(a); })
      .catch(() => { if (live) setAlive(false); });
    return () => { live = false; };
  }, [name, busy]);

  const bounce = async (wasAlive: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      if (wasAlive) await invoke("kill_agent", { persona: name, bin: null }).catch(() => {});
      const rows = await invoke<{ persona: string; channels: string[]; repo?: string; line?: string }[]>("spawned_agents").catch(() => []);
      const row = rows.find((r) => r.persona === name);
      await invoke("spawn_agent", {
        persona: name,
        channels: row?.channels ?? [],
        owner,
        relays: relaySet().join(","),
        repo: row?.repo ?? null,
        baseBranch: row?.line ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (alive === undefined) return <span>checking…</span>;
  if (busy) return <span>{alive ? "restarting…" : "starting…"}</span>;
  const verb = alive ? "restart" : "start";
  return (
    <span>
      <span>{alive ? "running" : "asleep"}</span>
      {owner ? (
        <>
          {" "}
          <button
            className="skill-link"
            title={
              alive
                ? `stop @${name}'s body and spawn a fresh one against the persona as it stands now (tools included)`
                : `spawn @${name} now — same as mentioning it, without the message`
            }
            onClick={() => void bounce(alive)}
          >
            {verb}
          </button>
        </>
      ) : (
        <span> — wakes on mention</span>
      )}
      {error ? <span className="ob-error"> {error}</span> : null}
    </span>
  );
}
