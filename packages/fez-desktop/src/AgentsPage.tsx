import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FezClient } from "@fezchat/client";
import AgentCard, { type AgentCardSkill } from "./AgentCard";
import { agentSkillStrip } from "./agent-skill-health";
import { useConfig } from "./config-store";

/**
 * The agents page.
 *
 * Agents were a drawer beside the chat: a list of names where the only
 * way to learn what one could do was to open it. They are the reason
 * fez exists, so they get a page — and the page's job is to answer, at
 * a glance, what each agent can do and which of them are broken.
 *
 * A roster is scanned row to row, so it takes --measure-scan.
 */
interface Row {
  name: string;
  pk?: string;
  description?: string;
  online: boolean;
  skills: AgentCardSkill[];
}

export default function AgentsPage({
  client,
  onOpen,
  onCreate,
  nonce,
}: {
  client: FezClient;
  onOpen: (name: string) => void;
  onCreate: () => void;
  /** Bumped after a persona edit so the page re-reads what changed. */
  nonce?: number;
}) {
  const { skills: catalog } = useConfig();
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const names = await invoke<string[]>("list_personas").catch(() => [] as string[]);
      // Read every persona at once; one slow file should not stall the
      // rest, and each read keeps its own catch so a single unreadable
      // persona cannot reject the batch.
      const contents = await Promise.all(
        names.map((name) => invoke<string>("read_persona", { name }).catch(() => ""))
      );
      if (cancelled) return;

      // The live roster carries the pubkey — and therefore the face.
      const live = new Map(
        [...client.agents().entries()].map(([pk, agentName]) => [agentName.toLowerCase(), pk])
      );

      setRows(
        names.map((name, i) => {
          const content = contents[i];
          const pk = live.get(name.toLowerCase());
          return {
            name,
            pk,
            description: content.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
            online: !!pk && client.isOnline(pk),
            skills: content ? agentSkillStrip(content, catalog) : [],
          };
        })
      );
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, catalog, nonce]);

  // The page's one live fact. "Broken" is the word the rule earns: an
  // agent naming a skill this machine cannot resolve runs reduced and
  // says nothing about it, which is the failure this roster exists to
  // make visible.
  const fact = useMemo(() => {
    const broken = rows.filter((r) => r.skills.some((s) => s.missing)).length;
    const n = rows.length;
    if (!n) return "";
    return broken ? `${n} agents · ${broken} broken` : `${n} agents`;
  }, [rows]);

  return (
    <div className="fez-page wide">
      <header className="page-head">
        <h1 className="page-title">agents</h1>
        <p className="page-sub">
          Every agent here is a persona on this machine. Give one a skill and it can use it on its
          next spawn.
        </p>
        <div className="page-rule">
          <button className="page-fact page-fact-action" onClick={onCreate}>
            + new agent
          </button>
          <span className="page-fact">{fact}</span>
        </div>
      </header>

      {loaded && rows.length === 0 ? (
        <div className="page-empty">
          <div className="page-empty-line">No agents yet.</div>
          <div className="page-empty-how">
            An agent is a persona file plus a harness. Make one and mention it in any channel to wake
            it.
          </div>
        </div>
      ) : (
        <div className="agent-grid">
          {rows.map((row) => (
            <AgentCard
              key={row.name}
              name={row.name}
              pk={row.pk}
              description={row.description}
              skills={row.skills}
              online={row.online}
              onOpen={() => onOpen(row.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
