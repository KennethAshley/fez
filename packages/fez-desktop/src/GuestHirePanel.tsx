import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GuestProtocolEvent } from "../../fez-client/src/guest-protocol.js";
import {
  beginGuestLease, beginGuestPayment, cancelGuestJob, createGuestJob, finishGuestLease, finishGuestPayment,
  markGuestLeaseUnknown, markGuestPaymentUnknown, readGuestJobs, readGuestLease, readLegacyGuestHire, guestRecoveryRecords,
  type GuestJob, type GuestJobScope, type GuestLease,
} from "./guest-job.js";
import { findByTask, tauriStore, updateRecord } from "./orchestration.js";

type Task = Extract<GuestProtocolEvent, { type: "task" }>;
type Result = Extract<GuestProtocolEvent, { type: "result" }>;
type Offer = Extract<GuestProtocolEvent, { type: "announce" }>;
type Account = { name: string; address: string };
const ARBITER = "escrowarbiter";
const terminal = (job: GuestJob) => ["paid", "refunded", "cancelled"].includes(job.state);
const uncertain = (job: GuestJob) => ["funding", "paying", "releasing", "refunding", "unknown"].includes(job.state);
const short = (text: string) => text.length > 86 ? `${text.slice(0, 86)}…` : text;
const brief = (text: string) => text.split("</thread_context>").at(-1)!.trim();

async function walletCall(args: string[]): Promise<unknown> {
  const response = await invoke<{ code: number; stdout: string; stderr: string }>("run_extension_bin", {
    extension: "wallet", bin: "fez-wallet", args: [...args, "--json"],
  });
  if (response.code !== 0) throw new Error(response.stderr.trim().split("\n").at(-1) || `Wallet exited ${response.code}`);
  return JSON.parse(response.stdout.trim().split("\n").at(-1) ?? "{}");
}

/** One native wallet action at a time across app windows; the persisted intent
 * also blocks retries after the window or process closes. */
async function withWalletLock(action: () => Promise<void>): Promise<void> {
  if (!navigator.locks?.request) throw new Error("Payments need a desktop version with cross-window locking support.");
  // ponytail: serialize guest wallet actions; per-account locks if contention matters.
  await navigator.locks.request("fez-guest-wallet", { ifAvailable: true }, async lock => {
    if (!lock) throw new Error("Another guest payment is in progress. Wait for its outcome.");
    await action();
  });
}

export function GuestHirePanel({ scope, tasks, results, offer }: {
  scope: GuestJobScope; tasks: Task[]; results: Result[]; offer?: Offer;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [walletReady, setWalletReady] = useState(false);
  const [renter, setRenter] = useState<{ persona: string; payerAddress: string; renterPubkey: string | null }>();
  const [jobs, setJobs] = useState<GuestJob[]>([]);
  const [lease, setLease] = useState<GuestLease>();
  const [legacy, setLegacy] = useState<ReturnType<typeof readLegacyGuestHire>>();
  const [storageError, setStorageError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [amount, setAmount] = useState("");
  const [persona, setPersona] = useState("");
  const refresh = () => {
    try {
      setJobs(readGuestJobs(localStorage, scope));
      setLease(readGuestLease(localStorage, scope));
      setLegacy(readLegacyGuestHire(localStorage, scope.guestPk));
      setStorageError(undefined);
    } catch (cause) { setStorageError(cause instanceof Error ? cause.message : "Payment records need recovery."); }
  };
  useEffect(() => {
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [scope.ownerPk, scope.guestPk, scope.relay]);
  useEffect(() => {
    let closed = false;
    void (async () => {
      try {
        const capability = await walletCall(["capabilities"]);
        if (!closed) setWalletReady(!!capability && typeof capability === "object" && "guestPayments" in capability && capability.guestPayments === 1);
      } catch { /* Older wallets must not silently ignore payment guard flags. */ }
      for (const extension of ["wallet", "fez-wallet"]) {
        try {
          const raw = JSON.parse(await invoke<string>("extension_storage_read", { name: extension })) as {
            addresses?: { treasury?: string; personas?: Record<string, string> };
          };
          const entries = [
            ...(raw.addresses?.treasury ? [{ name: "treasury", address: raw.addresses.treasury }] : []),
            ...Object.entries(raw.addresses?.personas ?? {}).map(([name, address]) => ({ name, address })),
          ].filter(account => typeof account.address === "string" && /^5[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(account.address));
          if (entries.length) { if (!closed) setAccounts(entries); return; }
        } catch { /* A missing mirror cannot authorize payment. */ }
      }
    })();
    return () => { closed = true; };
  }, []);
  useEffect(() => {
    let closed = false;
    setRenter(undefined);
    if (walletReady && persona && persona !== "treasury") void walletCall(["capabilities", "--as", persona]).then(value => {
      if (!closed && value && typeof value === "object" && "identity" in value && value.identity && typeof value.identity === "object") {
        const identity = value.identity;
        if ("persona" in identity && identity.persona === persona && "payerAddress" in identity && typeof identity.payerAddress === "string" &&
            "renterPubkey" in identity && typeof identity.renterPubkey === "string") {
          setRenter({ persona, payerAddress: identity.payerAddress, renterPubkey: identity.renterPubkey });
        }
      }
    }).catch(() => {});
    return () => { closed = true; };
  }, [persona, walletReady]);

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    try { await withWalletLock(action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Payment outcome could not be confirmed."); }
    finally { refresh(); busyRef.current = false; setBusy(false); }
  };
  const selected = tasks.find(task => task.event.id === requestId);
  const active = jobs.find(job => !terminal(job));
  const current = active ?? (!starting ? jobs.at(-1) : undefined);
  const locked = !walletReady || !!storageError || !!legacy || !!(active && uncertain(active)) || !!(lease && lease.state !== "confirmed");
  const payer = accounts.find(account => account.name === persona && account.name !== ARBITER);
  const arbiter = accounts.find(account => account.name === ARBITER);
  const quote = offer?.offer;
  const successfulResult = current ? results.find(result => result.taskId === current.requestId && result.status === "success") : undefined;
  const requireOffer = () => {
    if (!offer?.offer?.payTo || Date.now() / 1000 - offer.event.created_at > 900) throw new Error("A fresh signed payment offer is required.");
    return offer.offer;
  };
  const terms = (kind: "settle" | "escrow") => {
    if (!selected) throw new Error("Choose the exact job before locking terms.");
    if (!payer) throw new Error("Choose the paying account.");
    const offer = requireOffer();
    if (kind === "escrow" && (!arbiter || payer.name === "treasury")) throw new Error("Local test escrow requires a paying agent account and a separate arbiter account.");
    return createGuestJob(localStorage, scope, selected.event, {
      kind, amount: amount.trim(), persona: payer.name, payerAddress: payer.address, payTo: offer.payTo!,
      ...(kind === "escrow" && arbiter ? { escrow: { arbiterPersona: arbiter.name, arbiterAddress: arbiter.address } } : {}),
    });
  };
  const recordPayment = (job: GuestJob) => {
    if (job.state !== "paid" || !job.txHash) return;
    void findByTask(tauriStore.read, scope.guestPk, job.requestId).then(record => record && updateRecord(
      tauriStore.read, tauriStore.write, record.id, { hire: { kind: job.kind, paid: job.amount, txHash: job.txHash! } },
    )).catch(() => {});
  };
  const pay = async (job: GuestJob, action: "pay" | "fund" | "release" | "refund") => {
    const capability = await walletCall(["capabilities"]);
    if (!capability || typeof capability !== "object" || !("guestPayments" in capability) || capability.guestPayments !== 1) throw new Error("Update the wallet extension before paying for guest jobs.");
    const result = results.find(result => result.taskId === job.requestId && result.status === "success");
    const pending = beginGuestPayment(localStorage, scope, job.requestId, action, action === "pay" || action === "release" ? result?.event.id : undefined);
    refresh();
    try {
      let output: unknown;
      if (action === "pay") {
        output = await walletCall(["pay", pending.payTo, pending.amount, "--as", pending.persona,
          "--expect-payer", pending.payerAddress, "--to-pk", scope.guestPk, "--for", pending.requestId, "--market", scope.relay]);
      } else if (action === "fund") {
        output = await walletCall(["escrow", "open", pending.payTo, pending.escrow!.arbiterAddress, pending.amount,
          "--as", pending.persona, "--expect-payer", pending.payerAddress]);
      } else {
        const escrow = pending.escrow!;
        const args = ["escrow", action, pending.payerAddress, pending.payTo, escrow.arbiterAddress, pending.amount];
        const first = await walletCall([...args, "--as", pending.persona, "--expect-payer", pending.payerAddress]);
        if (!first || typeof first !== "object" || !("executed" in first) || typeof first.executed !== "boolean") throw new Error("Escrow approval outcome is unknown.");
        output = first.executed ? first : await walletCall([...args, "--as", escrow.arbiterPersona, "--expect-payer", escrow.arbiterAddress]);
      }
      const done = finishGuestPayment(localStorage, scope, job.requestId, output);
      recordPayment(done);
    } catch (cause) {
      // Even a CLI timeout may follow a confirmed transfer. Keep its captured terms.
      markGuestPaymentUnknown(localStorage, scope, job.requestId);
      throw cause;
    }
  };
  const start = (kind: "settle" | "escrow") => void run(async () => {
    const job = terms(kind);
    setStarting(false);
    if (kind === "escrow") await pay(job, "fund");
  });
  const rent = (hours: number) => void run(async () => {
    if (!selected || !payer || payer.name === "treasury") throw new Error("Choose a job and a paying agent account for priority.");
    const capability = await walletCall(["capabilities"]);
    if (!capability || typeof capability !== "object" || !("guestPayments" in capability) || capability.guestPayments !== 1) throw new Error("Update the wallet extension before paying for guest jobs.");
    if (renter?.renterPubkey !== scope.ownerPk || renter.payerAddress !== payer.address) throw new Error("Prepaid priority applies to the paying agent's own tasks, not this owner's conversation.");
    const currentOffer = requireOffer();
    if (!currentOffer.rateTaoHr) throw new Error("No signed priority rate is available.");
    const amount = (Math.round(hours * currentOffer.rateTaoHr * 1e9) / 1e9).toFixed(9);
    const intent = beginGuestLease(localStorage, scope, selected.event, { amount, hours, persona: payer.name,
      payerAddress: payer.address, payTo: currentOffer.payTo!, rateTaoHr: currentOffer.rateTaoHr, offerId: offer!.event.id });
    refresh();
    try {
      const output = await walletCall(["rent", scope.guestPk, String(hours), "--as", intent.persona, "--market", scope.relay,
        "--expect-pay-to", intent.payTo, "--expect-rate", String(intent.rateTaoHr), "--expect-offer", intent.offerId,
        "--expect-payer", intent.payerAddress, "--expect-renter", scope.ownerPk, "--max-amount", intent.amount, "--for", intent.requestId]);
      finishGuestLease(localStorage, scope, output);
    } catch (cause) { markGuestLeaseUnknown(localStorage, scope); throw cause; }
  });
  const recovery = () => {
    const blob = new Blob([JSON.stringify({ scope, ...guestRecoveryRecords(localStorage, scope) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `fez-job-recovery-${scope.guestPk.slice(0, 8)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <section className="guest-hire" aria-label="Guest job payments" style={{ whiteSpace: "normal", overflow: "visible" }}>
    <div className="dim">Testnet payments · opening this conversation grants no workspace access</div>
    {!walletReady ? <div className="dim">A wallet update with verified guest payments is required before paying.</div> : null}
    {legacy || storageError || (active && uncertain(active)) || (lease && lease.state !== "confirmed") ? <div role="alert" className="guest-hire-err">
      {legacy ? `An earlier hire needs wallet review${legacy.escrowAddress ? ` · escrow ${legacy.escrowAddress}` : ""}. Its original record is preserved.`
        : storageError ?? "A payment is pending or its outcome is unknown. Check the wallet before recovery; another payment is blocked."}
      <button className="guest-hire-link" onClick={recovery}>save recovery record</button>
    </div> : null}
    {current ? <div style={{ marginTop: 6 }}>
      <div>{`Job ${current.requestId.slice(0, 8)} · ${short(brief(current.brief))}`}</div>
      <div className="dim" style={{ overflowWrap: "anywhere" }}>{`${current.amount} tTAO · from ${current.persona} · to ${current.payTo}`}</div>
      {current.escrow ? <div className="dim">Local test escrow: buyer and arbiter approvals are controlled here. No independent dispute resolution.</div> : null}
      <div>{`Status: ${current.state}`}{current.txHash ? ` · tx ${current.txHash}` : ""}</div>
      {current.state === "agreed" && current.kind === "settle" || current.state === "escrowed" ? <>
        <button className="guest-hire-btn" disabled={busy || locked || !successfulResult}
          title="Confirm that you checked this job's result and authorize its agreed payment."
          onClick={() => void run(() => pay(current, current.kind === "escrow" ? "release" : "pay"))}>accept result &amp; pay</button>
        {!successfulResult ? <span className="dim"> · waiting for a verified successful result for this job</span> : null}
      </> : null}
      {current.state === "escrowed" ? <button className="guest-hire-link" disabled={busy || locked}
        onClick={() => void run(() => pay(current, "refund"))}>refund test escrow</button> : null}
      {current.state === "agreed" ? <button className="guest-hire-link" disabled={busy || locked}
        onClick={() => void run(async () => { cancelGuestJob(localStorage, scope, current.requestId); })}>cancel agreement</button> : null}
      {terminal(current) ? <button className="guest-hire-link" disabled={busy || locked} onClick={() => { setStarting(true); setRequestId(""); }}>new job agreement</button> : null}
    </div> : null}
    {!active && (!current || starting) ? <div style={{ marginTop: 6 }}>
      {!starting ? <>
        <span className="dim">{quote?.payTo ? `hireable · signed address ${quote.payTo.slice(0, 8)}…` : "no receive address verified yet"}</span>
        <button className="guest-hire-link" disabled={busy || locked || !quote?.payTo || !accounts.length}
          onClick={() => { setStarting(true); setPersona(accounts.find(account => account.name !== ARBITER)?.name ?? ""); }}>start a hire</button>
      </> : <>
        <div className="guest-hire-form" style={{ display: "flex", flexWrap: "wrap", marginBottom: 6 }}>
          <label>Job <select aria-label="Job to hire for" className="guest-hire-sel" value={requestId} onChange={event => setRequestId(event.target.value)}>
            <option value="">Choose a sent task</option>
            {tasks.filter(task => !jobs.some(job => job.requestId === task.event.id)).map(task => <option key={task.event.id} value={task.event.id}>{`${task.event.id.slice(0, 8)} · ${short(brief(task.event.content))}`}</option>)}
          </select></label>
          <label>Pay from <select aria-label="Pay from" className="guest-hire-sel" value={persona} onChange={event => setPersona(event.target.value)}>
            <option value="">Choose account</option>
            {accounts.filter(account => account.name !== ARBITER).map(account => <option key={account.name} value={account.name}>{account.name}</option>)}
          </select></label>
          <label>Price <input aria-label="Agreed price in tTAO" inputMode="decimal" className="guest-hire-amt" placeholder="tTAO" value={amount} onChange={event => setAmount(event.target.value)} /></label>
        </div>
        {selected ? <div className="dim">{brief(selected.event.content)}</div> : <div className="dim">Send the job brief first, then choose that exact task.</div>}
        {quote?.payTo ? <div className="dim" style={{ overflowWrap: "anywhere" }}>{`Reviewed recipient: ${quote.payTo}`}</div> : null}
        <button className="guest-hire-btn" disabled={busy || locked || !selected || !payer || !amount || !quote?.payTo} onClick={() => start("settle")}>lock terms · pay after acceptance</button>
        {arbiter && payer?.name !== "treasury" ? <>
          <div className="dim" style={{ marginTop: 6 }}>Local test escrow uses your paying account and local arbiter. It has no independent dispute protection.</div>
          <button className="guest-hire-btn" disabled={busy || locked || !selected || !payer || !amount || !quote?.payTo} onClick={() => start("escrow")}>fund test escrow now</button>
        </> : null}
        <button className="guest-hire-link" disabled={busy} onClick={() => setStarting(false)}>close</button>
        {quote?.rateTaoHr && payer && payer.name !== "treasury" ? <div style={{ marginTop: 8 }}>
          <span className="dim">Prepaid priority · no automatic renewal · does not guarantee delivery</span>
          {renter?.renterPubkey !== scope.ownerPk || renter.payerAddress !== payer.address ? <div className="dim">Priority belongs to the paying agent's own task identity. This owner conversation cannot use that lease.</div> : null}
          {([0.25, 1] as const).map(hours => <button key={hours} className="guest-hire-btn" disabled={busy || locked || !selected || renter?.renterPubkey !== scope.ownerPk || renter.payerAddress !== payer.address}
            onClick={() => rent(hours)}>{`${hours === 1 ? "1h" : "15m"} · ${(Math.round(hours * quote.rateTaoHr! * 1e9) / 1e9).toFixed(9)} tTAO`}</button>)}
        </div> : null}
      </>}
    </div> : null}
    {lease?.state === "confirmed" ? <div className="dim">{`Prepaid priority receipt published · paid through ${new Date(lease.paidThrough).toLocaleTimeString()} · from ${lease.persona}`}</div> : null}
    {jobs.filter(terminal).length > 1 ? <details style={{ marginTop: 6 }}><summary>Past jobs</summary>{jobs.filter(terminal).map(job => <div key={job.requestId}>{`${job.requestId.slice(0, 8)} · ${job.state} · ${job.amount} tTAO`}</div>)}</details> : null}
    {busy ? <div role="status">Waiting for wallet confirmation…</div> : null}
    {error ? <div role="alert" className="guest-hire-err">{error}</div> : null}
  </section>;
}
