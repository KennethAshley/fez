/**
 * @fez proposed a market hire; this card is the HUMAN half (spec
 * 2026-09-04). "hire" opens the guest DM with the task prefilled — the
 * user's send is the send, and any money moves through the DM strip's
 * proven rails on this machine's wallet. "not now" is a real decision,
 * logged: declines are the preference signal the corpus needs. An IGNORED
 * proposal is a decision too (spec 2026-09-04, C1a) — the mount effect
 * records it "pending" immediately rather than waiting for a click, so a
 * card nobody touches still lands in the corpus instead of vanishing.
 */
import { useContext, useEffect, useState } from "react";
import { parseHireProposal } from "./hire-proposal";
import { recordProposal, updateRecord, findByProposal, tauriStore } from "./orchestration";
import { openGuestDm } from "./gui-extensions";
import { BAZAAR_RELAY } from "./bazaar-record";
import { MdContext } from "./App";

export default function HireProposalCard({ fenceText, roster }: { fenceText: string; roster: string[] }) {
  const p = parseHireProposal(fenceText);
  const { authorName } = useContext(MdContext);
  const [decision, setDecision] = useState<"pending" | "accepted" | "declined">("pending");
  const [recId, setRecId] = useState<string>();

  const recordInput = (proposal: NonNullable<typeof p>) => ({
    task: proposal.task, roster,
    picked: { pk: proposal.pk, name: proposal.name, ...(proposal.rateTaoHr !== undefined ? { rateTaoHr: proposal.rateTaoHr } : {}) },
    why: proposal.why, kind: proposal.kind,
    ...(proposal.priceEstTao !== undefined ? { priceEstTao: proposal.priceEstTao } : {}),
  });

  // A remounted card (leave the channel, come back) starts with no state
  // of its own — without this it re-offers the buttons on an
  // already-decided proposal, and a click double-logs it. Hooks run
  // unconditionally; the null-return for a malformed proposal stays below.
  useEffect(() => {
    if (!p) return;
    let live = true;
    void findByProposal(tauriStore.read, p.pk, p.task)
      .then(async (rec) => {
        if (!live) return;
        if (rec) {
          setRecId(rec.id);
          if (rec.decision !== "pending") setDecision(rec.decision);
          return;
        }
        // No record: this proposal has never been seen before, ignored or
        // not. Record it now (decision starts "pending") so an ignored
        // card still leaves a trace. Re-check right before creating — two
        // card instances (or a StrictMode double-invoke) can both reach
        // here before either write lands.
        const recheck = await findByProposal(tauriStore.read, p.pk, p.task);
        if (!live) return;
        if (recheck) {
          setRecId(recheck.id);
          if (recheck.decision !== "pending") setDecision(recheck.decision);
          return;
        }
        const id = await recordProposal(tauriStore.read, tauriStore.write, recordInput(p));
        if (live) setRecId(id);
      })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.pk, p?.task]);

  if (!p) return null; // malformed proposal: nothing, never a broken card

  const log = async (d: "accepted" | "declined") => {
    setDecision(d);
    try {
      const id = recId ?? await recordProposal(tauriStore.read, tauriStore.write, recordInput(p));
      setRecId(id);
      await updateRecord(tauriStore.read, tauriStore.write, id, { decision: d });
    } catch { /* the log must never block the hire */ }
  };

  const relay = p.relay ?? BAZAAR_RELAY;

  return (
    <span className="hire-proposal">
      <span className="hp-head">{authorName ? `@${authorName} suggests the market` : "a market proposal"}</span>
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
              openGuestDm({ pk: p.pk, relay, name: p.name, ...(p.rateTaoHr !== undefined ? { rateTaoHr: p.rateTaoHr } : {}), draft: p.task });
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
