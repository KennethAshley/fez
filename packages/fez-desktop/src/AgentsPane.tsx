import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient, ObserverEntry, WireEvent } from "@fez/client";
import type { BrowserWire } from "./wire";
import ActivityFeed from "./ActivityFeed";
import Avatar from "./Avatar";
import PersonaEditor from "./PersonaEditor";

/**
 * The agents surface — Buzz's biggest pane, fez-shaped. Roster of every
 * agent we know (kind-47000 metadata), and a per-agent detail stacking
 * the owner's private windows: live activity (observer frames), engram
 * memory (30174, decrypted with the agent↔owner conversation key), turn
 * costs (47030), plus cancel / DM / invite-to-channel actions. All of it
 * reads existing wire data — the pane is pure rendering.
 */

const KIND_TURN_METRIC = 47030;

interface EngramView {
  slug: string;
  text: string;
  ts: number;
}

interface CostSummary {
  turns: number;
  done: number;
  failed: number;
  cancelled: number;
  ms: number;
}

export default function AgentsPane({
  client,
  wire,
  activity,
  working,
  onCancel,
  onDm,
  onClose,
}: {
  client: FezClient;
  wire: BrowserWire;
  activity: ReadonlyMap<string, ObserverEntry[]>;
  working: ReadonlyMap<string, { activity: string; ts: number }>;
  onCancel: (agentName: string) => void;
  onDm: (agentPk: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string>(); // agent pk
  const [creating, setCreating] = useState(false);
  const [editingPersona, setEditingPersona] = useState<string>();
  // Persona files on disk — includes agents that have never spawned
  // (no 47000 metadata yet), which would otherwise be invisible here.
  const [localPersonas, setLocalPersonas] = useState<string[]>([]);
  const [personaNonce, setPersonaNonce] = useState(0);
  useEffect(() => {
    void invoke<string[]>("list_personas").then(setLocalPersonas).catch(() => setLocalPersonas([]));
  }, [personaNonce]);
  const roster = useMemo(
    () =>
      [...client.agents().entries()]
        .map(([pk, name]) => ({ pk, name, online: client.isOnline(pk) }))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [client]
  );
  const current = selected ? roster.find((agent) => agent.pk === selected) : undefined;
  const knownNames = new Set(roster.map((agent) => agent.name.toLowerCase()));
  const unspawned = localPersonas.filter((name) => !knownNames.has(name.toLowerCase()));

  return (
    <aside className="pane">
      <header className="pane-head">
        {current || creating || editingPersona ? (
          <button className="pane-back" onClick={() => { setSelected(undefined); setCreating(false); setEditingPersona(undefined); }}>
            ← agents
          </button>
        ) : (
          <span>@ agents</span>
        )}
        {!current && !creating && !editingPersona && (
          <button className="agent-action" onClick={() => setCreating(true)}>+ new agent</button>
        )}
        <button className="pane-close" onClick={onClose}>✕</button>
      </header>
      {editingPersona && (
        <PersonaEditor
          name={editingPersona}
          onDone={(changed) => {
            setEditingPersona(undefined);
            if (changed) setPersonaNonce((n) => n + 1);
          }}
        />
      )}
      {creating && (
        <CreateAgentForm
          onDone={() => {
            setCreating(false);
            setPersonaNonce((n) => n + 1);
          }}
        />
      )}
      {!current && !creating && !editingPersona && (
        <div className="pane-body">
          {roster.length === 0 && (
            <div className="pane-empty">no agents known yet — they appear when their 47000 metadata reaches your relay</div>
          )}
          {roster.map((agent) => {
            const busy = working.get(agent.name);
            const active = busy && Date.now() - busy.ts < 30_000;
            return (
              <button key={agent.pk} className="agent-row" onClick={() => setSelected(agent.pk)}>
                <Avatar pk={agent.pk} size={18} title={agent.name} />
                <span className={agent.online ? "dot on" : "dot off"} />
                <span className="agent-name">@{agent.name}</span>
                {active && <span className="working">⚙</span>}
                <span className="agent-sub">
                  {active ? busy.activity : client.statusOf(agent.pk) ?? (agent.online ? "online" : "offline")}
                </span>
              </button>
            );
          })}
          {unspawned.length > 0 && (
            <>
              <div className="manage-section">on this machine (never summoned)</div>
              {unspawned.map((name) => (
                <button key={name} className="agent-row" title="edit persona" onClick={() => setEditingPersona(name)}>
                  <span className="agent-ghost">◌</span>
                  <span className="agent-name">@{name}</span>
                  <span className="agent-sub">mention @{name} to summon · click to edit</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {current && !creating && !editingPersona && (
        <AgentDetail
          client={client}
          wire={wire}
          pk={current.pk}
          name={current.name}
          online={current.online}
          entries={activity.get(current.name) ?? []}
          workingHeadline={working.get(current.name)}
          onCancel={() => onCancel(current.name)}
          onDm={() => onDm(current.pk)}
          onEdit={
            localPersonas.some((name) => name.toLowerCase() === current.name.toLowerCase())
              ? () => setEditingPersona(localPersonas.find((name) => name.toLowerCase() === current.name.toLowerCase())!)
              : undefined
          }
        />
      )}
    </aside>
  );
}

function AgentDetail({
  client,
  wire,
  pk,
  name,
  online,
  entries,
  workingHeadline,
  onCancel,
  onDm,
  onEdit,
}: {
  client: FezClient;
  wire: BrowserWire;
  pk: string;
  name: string;
  online: boolean;
  entries: ObserverEntry[];
  workingHeadline?: { activity: string; ts: number };
  onCancel: () => void;
  onDm: () => void;
  onEdit?: () => void;
}) {
  const [tab, setTab] = useState<"activity" | "memory" | "costs">("activity");
  const [engrams, setEngrams] = useState<EngramView[] | "loading" | "error">();
  const [costs, setCosts] = useState<CostSummary | "loading">();
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = workingHeadline && Date.now() - workingHeadline.ts < 30_000;

  useEffect(() => {
    if (tab === "activity") bottomRef.current?.scrollIntoView({ behavior: "auto" });
  });

  // Engram heads: decrypt everything addressed to us, newest body per
  // slug wins, tombstones (value: null) drop out.
  useEffect(() => {
    if (tab !== "memory" || engrams) return;
    setEngrams("loading");
    void (async () => {
      try {
        const events = await client.queryEngrams(pk);
        const bySlug = new Map<string, EngramView>();
        for (const event of events as WireEvent[]) {
          try {
            const body = JSON.parse(client.decryptFrom(pk, event.content)) as {
              slug?: string;
              value?: string | null;
              profile?: string;
            };
            if (!body.slug) continue;
            const existing = bySlug.get(body.slug);
            if (existing && existing.ts >= event.created_at) continue;
            bySlug.set(body.slug, {
              slug: body.slug,
              text: body.profile ?? body.value ?? "",
              ts: event.created_at,
            });
          } catch {
            /* not decryptable by us */
          }
        }
        setEngrams(
          [...bySlug.values()]
            .filter((engram) => engram.text)
            .sort((a, b) => (a.slug === "core" ? -1 : b.slug === "core" ? 1 : b.ts - a.ts))
        );
      } catch {
        setEngrams("error");
      }
    })();
  }, [tab, engrams, client, pk]);

  useEffect(() => {
    if (tab !== "costs" || costs) return;
    setCosts("loading");
    void (async () => {
      const events = await wire.query([{ kinds: [KIND_TURN_METRIC], "#p": [client.pubkey], limit: 500 }]);
      const summary: CostSummary = { turns: 0, done: 0, failed: 0, cancelled: 0, ms: 0 };
      for (const event of events) {
        try {
          const metric = JSON.parse(wire.decrypt(event.pubkey, event.content)) as {
            agent?: string;
            status?: string;
            durationMs?: number;
          };
          if (metric.agent !== name) continue;
          summary.turns++;
          if (metric.status === "done") summary.done++;
          else if (metric.status === "failed") summary.failed++;
          else if (metric.status === "cancelled") summary.cancelled++;
          summary.ms += metric.durationMs ?? 0;
        } catch {
          /* not ours */
        }
      }
      setCosts(summary);
    })();
  }, [tab, costs, wire, client, name]);

  // Invite into the CURRENT channel — creator-only, and only if absent.
  const scope = client.state.currentChannel();
  const canInvite =
    !!scope && scope.community.creator === client.pubkey && !scope.channel.members.has(pk);

  const invite = async () => {
    setInviteState("sending");
    try {
      await client.invite(pk, "bot");
      setInviteState("done");
    } catch {
      setInviteState("error");
    }
  };

  return (
    <>
      <div className="agent-head">
        <div className="agent-title">
          <Avatar pk={pk} size={24} title={name} />
          <span className={online ? "dot on" : "dot off"} /> @{name}
          {busy && <span className="working">⚙</span>}
        </div>
        {busy && <div className="agent-headline shimmer">{workingHeadline.activity}</div>}
        {client.statusOf(pk) && <div className="agent-sub">{client.statusOf(pk)}</div>}
        <div className="agent-actions">
          {busy && (
            <button className="cancel" title="abort the in-flight turn (owner-signed)" onClick={onCancel}>
              ⏹ cancel turn
            </button>
          )}
          <button className="agent-action" onClick={onDm}>✉ dm</button>
          {onEdit && <button className="agent-action" onClick={onEdit}>✎ edit persona</button>}
          {canInvite && (
            <button className="agent-action" disabled={inviteState === "sending"} onClick={() => void invite()}>
              {inviteState === "idle" && `+ invite to #${scope.channel.name}`}
              {inviteState === "sending" && "inviting…"}
              {inviteState === "done" && "✓ invited"}
              {inviteState === "error" && "invite failed"}
            </button>
          )}
        </div>
        <div className="agent-tabs">
          {(["activity", "memory", "costs"] as const).map((name) => (
            <button key={name} className={tab === name ? "agent-tab active" : "agent-tab"} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="pane-body">
        {tab === "activity" && (
          <>
            <ActivityFeed entries={entries} emptyNote={`no activity this session — frames stream here while @${name} works (encrypted to you)`} />
            <div ref={bottomRef} />
          </>
        )}
        {tab === "memory" && (
          <>
            {engrams === "loading" && <div className="pane-empty">decrypting…</div>}
            {engrams === "error" && <div className="pane-empty">couldn't load memory from the relay</div>}
            {Array.isArray(engrams) && engrams.length === 0 && (
              <div className="pane-empty">no memory yet — @{name} writes engrams as it learns (readable only by you two)</div>
            )}
            {Array.isArray(engrams) &&
              engrams.map((engram) => (
                <div key={engram.slug} className="engram">
                  <div className="engram-slug">
                    {engram.slug}
                    <span className="time"> · {new Date(engram.ts * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                  </div>
                  <div className="engram-body">{engram.text}</div>
                </div>
              ))}
          </>
        )}
        {tab === "costs" && (
          <>
            {costs === "loading" && <div className="pane-empty">decrypting…</div>}
            {costs && costs !== "loading" && costs.turns === 0 && (
              <div className="pane-empty">no turn metrics yet for @{name}</div>
            )}
            {costs && costs !== "loading" && costs.turns > 0 && (
              <div className="cost-row">
                <div className="cost-detail">{costs.turns} turns · {costs.done} ok · {costs.failed} failed · {costs.cancelled} cancelled</div>
                <div className="cost-detail">{(costs.ms / 60_000).toFixed(1)} min compute</div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Agent creation, GUI-side — Buzz's AgentDefinitionDialog reduced to the
 * fez contract: the persona MD file IS the agent. The shell writes
 * ~/.fez/personas/<name>.md (refusing overwrite); herdr/sentinel spawn
 * it on its first @mention, with its own stable key. No daemon to
 * configure, nothing to start.
 */
function CreateAgentForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [harness, setHarness] = useState("claude-code");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | string>("idle");

  const create = async () => {
    setState("saving");
    const front = [
      "---",
      `harness: ${harness}`,
      ...(description.trim() ? [`description: ${description.trim().replace(/\n/g, " ")}`] : []),
      "---",
      "",
    ].join("\n");
    try {
      await invoke<string>("write_persona", { name: name.trim(), content: front + (prompt.trim() || `You are ${name.trim()}.`) + "\n" });
      setState("done");
    } catch (err) {
      setState(String(err));
    }
  };

  if (state === "done") {
    return (
      <div className="pane-body">
        <div className="manage-notice">✓ @{name.trim()} created</div>
        <div className="settings-hint">
          Mention @{name.trim()} in any channel and it spawns with its own key, introduces itself, and joins the
          roster. The persona lives at ~/.fez/personas/{name.trim()}.md — edit it there anytime.
        </div>
        <button className="agent-action" onClick={onDone}>back to agents</button>
      </div>
    );
  }

  return (
    <div className="pane-body">
      <div className="settings-field">
        <label>name (becomes the @mention)</label>
        <input
          className="manage-input"
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="scout"
          onChange={(e) => setName(e.target.value.toLowerCase())}
        />
      </div>
      <div className="settings-field">
        <label>harness</label>
        <select className="manage-select" value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="claude-code">claude-code</option>
          <option value="pi">pi</option>
        </select>
      </div>
      <div className="settings-field">
        <label>description (helps @fez route to it)</label>
        <input
          className="manage-input"
          value={description}
          placeholder="what this agent is for"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="settings-field">
        <label>system prompt</label>
        <textarea
          className="doc-textarea persona-prompt"
          value={prompt}
          spellCheck={false}
          placeholder="You are…"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      {state !== "idle" && state !== "saving" && <div className="ob-error">{state}</div>}
      <div className="agent-actions">
        <button className="agent-action" disabled={!name.trim() || state === "saving"} onClick={() => void create()}>
          {state === "saving" ? "creating…" : "create agent"}
        </button>
        <button className="agent-action" onClick={onDone}>cancel</button>
      </div>
    </div>
  );
}
