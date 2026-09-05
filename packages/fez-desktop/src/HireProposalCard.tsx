/**
 * @fez proposed a market hire; this card is the HUMAN half (spec
 * 2026-09-04). "hire" opens the guest DM with the task prefilled — the
 * user's send is the send, and any money moves through the DM strip's
 * proven rails on this machine's wallet. "not now" is a real decision,
 * logged: declines are the preference signal the corpus needs.
 */
import { useState } from "react";
import { parseHireProposal } from "./hire-proposal";
import { recordProposal, updateRecord, tauriStore } from "./orchestration";
import { openGuestDm } from "./gui-extensions";

const BAZAAR_RELAY = "wss://bazaar.fez.chat";

export default function HireProposalCard({ fenceText, roster }: { fenceText: string; roster: string[] }) {
  const p = parseHireProposal(fenceText);
  const [decision, setDecision] = useState<"pending" | "accepted" | "declined">("pending");
  const [recId, setRecId] = useState<string>();
  if (!p) return null; // malformed proposal: nothing, never a broken card

  const log = async (d: "accepted" | "declined") => {
    setDecision(d);
    try {
      const id = recId ?? await recordProposal(tauriStore.read, tauriStore.write, {
        task: p.task, roster,
        picked: { pk: p.pk, name: p.name, ...(p.rateTaoHr !== undefined ? { rateTaoHr: p.rateTaoHr } : {}) },
        why: p.why, kind: p.kind,
        ...(p.priceEstTao !== undefined ? { priceEstTao: p.priceEstTao } : {}),
      });
      setRecId(id);
      await updateRecord(tauriStore.read, tauriStore.write, id, { decision: d });
    } catch { /* the log must never block the hire */ }
  };

  return (
    <span className="hire-proposal">
      <span className="hp-head">@fez suggests the market</span>
      <span className="hp-why">{p.why}</span>
      <span className="hp-who">
        {p.name}
        {p.rateTaoHr !== undefined ? <span className="hp-rate">{` · ${p.rateTaoHr} tτ/hr`}</span> : null}
        {p.priceEstTao !== undefined ? <span className="hp-rate">{` · est ${p.priceEstTao} tτ (${p.kind})`}</span> : null}
      </span>
      {decision === "pending" ? (
        <span className="hp-actions">
          <button
            className="guest-hire-btn"
            title={`opens a public DM with ${p.name}, task prefilled — you press send; payment happens in the DM through your own wallet`}
            onClick={() => {
              void log("accepted");
              openGuestDm({ pk: p.pk, relay: BAZAAR_RELAY, name: p.name, ...(p.rateTaoHr !== undefined ? { rateTaoHr: p.rateTaoHr } : {}), draft: p.task });
            }}
          >
            open the hire
          </button>
          <button className="guest-hire-link" onClick={() => void log("declined")}>not now</button>
        </span>
      ) : (
        <span className="hp-decided">{decision === "accepted" ? `→ hiring ${p.name} in the DM rail` : "declined"}</span>
      )}
    </span>
  );
}
