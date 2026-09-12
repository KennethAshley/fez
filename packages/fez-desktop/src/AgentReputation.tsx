import { useEffect, useMemo, useState } from "react";
import type { SaltEvidence } from "../../fez-client/src/salt";
import { tierLabel, tierTitle, type SaltPanel } from "./salt-record";
import { extensionAgentProfileSections, type AgentProfileContext, type AgentProfileSection } from "./gui-extensions";
import { MountPoint } from "./MountPoint";
import "./agent-reputation.css";

export function SaltSection({ panel, viewer, displayName }: {
  panel: SaltPanel | "error" | undefined;
  viewer?: string;
  displayName?: (pk: string) => string;
}) {
  if (panel === undefined) return <p className="settings-hint" role="status">Checking reputation…</p>;
  if (panel === "error") return <p className="settings-hint" role="status">Reputation unavailable. The relays could not be reached.</p>;
  const evidence = [...panel.ring0, ...panel.ring1, ...panel.ring2];
  const group = (kind: SaltEvidence["kind"], title: string, empty: string) => {
    const entries = evidence.filter((e) => e.kind === kind);
    const rows = (items: SaltEvidence[]) => <ul className="reputation-evidence">{items.map((e) => {
      const name = displayName?.(e.signer);
      const who = e.signer === viewer ? "You" : name && name !== e.signer ? name : `${e.signer.slice(0, 8)}…${e.signer.slice(-4)}`;
      const date = new Date(e.at * 1000);
      const relationship = panel.ring0.includes(e) ? (e.signer === viewer ? "Your endorsement" : "Your agent")
        : panel.ring1.includes(e) ? "In your circle" : "Outside your circle";
      return <li key={`${e.signer}:${e.kind}:${e.workId ?? ""}`}>
        <div className="reputation-byline"><b title={e.signer}>{who}</b><span>{e.kind === "chit" && e.signer === viewer ? "You accepted this work" : relationship}</span></div>
        <p>{e.note || "Accepted work"}</p>
        <small><time dateTime={Number.isFinite(date.getTime()) ? date.toISOString() : undefined}>{Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "Date unavailable"}</time>
          {e.workId && <span title={e.workId}> · work {e.workId.slice(0, 8)}</span>}
          {e.moneyBacked && <span> · payment receipt (unverified)</span>}</small>
      </li>;
    })}</ul>;
    return <section className="reputation-group" aria-label={title}>
      <h4>{title} <span>{entries.length}</span></h4>
      {entries.length ? rows(entries.slice(0, 5)) : <p className="settings-hint">{empty}</p>}
      {entries.length > 5 && <details><summary>Show {entries.length - 5} more</summary>{rows(entries.slice(5))}</details>}
    </section>;
  };
  return <div className="agent-reputation">
    <p className="reputation-tier" title={tierTitle(panel.tier)}><b>Salt</b><span>{tierLabel(panel.tier)}</span></p>
    {group("vouch", "Vouched by", "No active vouches found.")}
    {group("chit", "Chits", "No accepted-work chits found.")}
    <p className="settings-hint">From the queried relays. Endorsements and accepted work are separate signals.</p>
    {panel.excluded > 0 && <p className="settings-hint">{panel.excluded} household {panel.excluded === 1 ? "entry" : "entries"} excluded from Salt.</p>}
  </div>;
}

function Contribution({ section, pubkey, persona }: AgentProfileContext & { section: AgentProfileSection }) {
  const render = useMemo(() => (host?: HTMLElement) => section.render({ pubkey, persona }, host), [section, pubkey, persona]);
  return <section className="reputation-group" aria-label={section.label}>
    <h4>{section.label} <span>{section.source}</span></h4>
    <MountPoint render={render} />
  </section>;
}

/** Feature data stays in extensions; both profile surfaces mount the same contributions. */
export function AgentProfileExtras(props: AgentProfileContext) {
  const [sections, setSections] = useState(() => [...extensionAgentProfileSections()]);
  useEffect(() => {
    const changed = () => setSections([...extensionAgentProfileSections()]);
    window.addEventListener("fez-gui-extensions-changed", changed);
    changed();
    return () => window.removeEventListener("fez-gui-extensions-changed", changed);
  }, []);
  return <>{sections.map((section) => <Contribution key={`${section.source}:${section.label}`} section={section} {...props} />)}</>;
}
