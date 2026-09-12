/** Durable payment intent for guest jobs. Call mutations under the scope's Web Lock:
 * localStorage preserves pending outcomes across restarts, but is not a cross-window lock. */
export interface GuestJobStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface GuestJobScope { ownerPk: string; guestPk: string; relay: string }
export interface GuestJobRequest { id: string; kind: number; pubkey: string; content: string; tags: string[][] }
export interface GuestJobTerms {
  kind: "settle" | "escrow"; amount: string; persona: string; payerAddress: string; payTo: string;
  escrow?: { arbiterPersona: string; arbiterAddress: string };
}
export interface GuestJob extends GuestJobTerms {
  version: 1; scope: GuestJobScope; requestId: string; brief: string; deadline: number | null; at: number;
  state: "agreed" | "funding" | "escrowed" | "paying" | "releasing" | "refunding" | "paid" | "refunded" | "cancelled" | "unknown";
  /** Requester's acceptance, not an independent validator grade. */
  acceptedResultId?: string;
  txHash?: string; updatedAt?: number;
  escrow?: { arbiterPersona: string; arbiterAddress: string; addr?: string; fundingTxHash?: string };
}
export interface GuestLeaseTerms {
  amount: string; persona: string; payerAddress: string; payTo: string;
  hours: number; rateTaoHr: number; offerId: string;
}
export interface GuestLease extends GuestLeaseTerms {
  version: 1; scope: GuestJobScope; requestId: string; brief: string; deadline: number | null; at: number;
  state: "pending" | "confirmed" | "unknown"; paidThrough: number; txHash?: string; receiptId?: string;
}

const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const address = (x: unknown): x is string => typeof x === "string" && /^5[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(x);
const persona = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(x);
const tx = (x: unknown): x is string => typeof x === "string" && /^0x[a-fA-F0-9]{64}$/.test(x);
const time = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
function amount(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,9})?$/.test(raw)) throw new Error("Invalid job amount");
  const [whole, fraction = ""] = raw.split(".");
  const value = BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (value <= 0n) throw new Error("Job amount must be greater than zero");
  return value;
}
function scopeOf(scope: GuestJobScope): GuestJobScope {
  if (!id(scope.ownerPk) || !id(scope.guestPk) || scope.ownerPk === scope.guestPk) throw new Error("Invalid guest job scope");
  const relay = new URL(scope.relay);
  if (!["ws:", "wss:"].includes(relay.protocol) || relay.username || relay.password || relay.hash) throw new Error("Invalid guest relay");
  return { ownerPk: scope.ownerPk, guestPk: scope.guestPk, relay: relay.href };
}
export const guestJobStorageKey = (scope: GuestJobScope): string => `fez-guest-jobs-v1:${encodeURIComponent(JSON.stringify(scopeOf(scope)))}`;
const leaseKey = (scope: GuestJobScope) => `${guestJobStorageKey(scope)}:lease`;
/** Export original storage bytes even when a damaged record prevents normal loading. */
export function guestRecoveryRecords(storage: GuestJobStorage, scope: GuestJobScope): { jobsRaw: string | null; leaseRaw: string | null; legacyHireRaw: string | null } {
  return { jobsRaw: storage.getItem(guestJobStorageKey(scope)), leaseRaw: storage.getItem(leaseKey(scope)), legacyHireRaw: storage.getItem(`fez-hire-${scope.guestPk}`) };
}
const terminal = (job: GuestJob) => ["paid", "refunded", "cancelled"].includes(job.state);
const pending = (job: GuestJob) => ["funding", "paying", "releasing", "refunding", "unknown"].includes(job.state);
function validatePaymentTerms(value: Record<string, unknown>): void {
  amount(value.amount);
  if (!persona(value.persona) || !address(value.payerAddress) || !address(value.payTo)) throw new Error("Invalid payment account or recipient address");
}
function validateJobTerms(value: Record<string, unknown>): void {
  validatePaymentTerms(value);
  if (!["settle", "escrow"].includes(String(value.kind))) throw new Error("Invalid job kind");
  if (value.kind === "escrow") {
    const escrow = value.escrow;
    if (!object(escrow) || !persona(escrow.arbiterPersona) || !address(escrow.arbiterAddress) ||
        new Set([value.payerAddress, value.payTo, escrow.arbiterAddress]).size !== 3) throw new Error("Invalid escrow participants");
  } else if (value.escrow !== undefined) throw new Error("Settlement job cannot change to escrow");
}
function validateLeaseTerms(value: Record<string, unknown>): void {
  validatePaymentTerms(value);
  if (value.persona === "treasury" || typeof value.hours !== "number" || !Number.isFinite(value.hours) || value.hours <= 0 || value.hours > 24 ||
      typeof value.rateTaoHr !== "number" || !Number.isFinite(value.rateTaoHr) || value.rateTaoHr <= 0 || !id(value.offerId) ||
      amount(value.amount) !== BigInt(Math.round(value.hours * value.rateTaoHr * 1e9))) throw new Error("Invalid lease quote");
}
function requestFields(scope: GuestJobScope, request: GuestJobRequest) {
  const recipients = request.tags.filter(t => t[0] === "p");
  if (!id(request.id) || request.kind !== 47001 || request.pubkey !== scope.ownerPk || recipients.length !== 1 ||
      recipients[0]?.[1] !== scope.guestPk || !request.content.trim()) throw new Error("Job needs the actual directed owner request");
  const deadline = Number(request.tags.find(t => t[0] === "deadline")?.[1]);
  return { requestId: request.id, brief: request.content, deadline: time(deadline) ? deadline : null };
}
function validBase(value: Record<string, unknown>, scope: GuestJobScope): boolean {
  return value.version === 1 && object(value.scope) && guestJobStorageKey(value.scope as unknown as GuestJobScope) === guestJobStorageKey(scope) &&
    id(value.requestId) && typeof value.brief === "string" && value.brief.trim().length > 0 && time(value.at) &&
    (value.deadline === null || time(value.deadline)) && (value.txHash === undefined || tx(value.txHash));
}

/** Invalid persisted state is recoverable evidence, never an empty/new payment slot. */
export function readGuestJobs(storage: GuestJobStorage, scope: GuestJobScope): GuestJob[] {
  const raw = storage.getItem(guestJobStorageKey(scope));
  if (raw === null) return [];
  try {
    const jobs: unknown = JSON.parse(raw);
    if (!Array.isArray(jobs)) throw new Error();
    const seen = new Set<string>();
    for (const value of jobs) {
      if (!object(value) || !validBase(value, scope)) throw new Error();
      validateJobTerms(value);
      if (!["agreed", "funding", "escrowed", "paying", "releasing", "refunding", "paid", "refunded", "cancelled", "unknown"].includes(String(value.state)) ||
          (value.acceptedResultId !== undefined && !id(value.acceptedResultId)) || seen.has(String(value.requestId))) throw new Error();
      if (value.kind === "settle" && ["funding", "escrowed", "releasing", "refunding", "refunded"].includes(String(value.state))) throw new Error();
      if (value.kind === "escrow" && value.state === "paying") throw new Error();
      if (["paying", "releasing", "paid"].includes(String(value.state)) && !id(value.acceptedResultId)) throw new Error();
      if (["paid", "refunded"].includes(String(value.state)) && !tx(value.txHash)) throw new Error();
      if (object(value.escrow)) {
        if ((value.escrow.addr !== undefined && !address(value.escrow.addr)) || (value.escrow.fundingTxHash !== undefined && !tx(value.escrow.fundingTxHash))) throw new Error();
        if (["escrowed", "releasing", "refunding", "paid", "refunded"].includes(String(value.state)) &&
            (!address(value.escrow.addr) || !tx(value.escrow.fundingTxHash))) throw new Error();
      }
      seen.add(String(value.requestId));
    }
    if ((jobs as GuestJob[]).filter(j => !terminal(j)).length > 1) throw new Error();
    return jobs as GuestJob[];
  } catch { throw new Error("Stored guest job state needs recovery; no payment was started"); }
}
function writeJob(storage: GuestJobStorage, scope: GuestJobScope, job: GuestJob): GuestJob {
  const jobs = readGuestJobs(storage, scope);
  storage.setItem(guestJobStorageKey(scope), JSON.stringify([...jobs.filter(j => j.requestId !== job.requestId), job]));
  return job;
}
function getJob(storage: GuestJobStorage, scope: GuestJobScope, requestId: string): GuestJob {
  const job = readGuestJobs(storage, scope).find(j => j.requestId === requestId);
  if (!job) throw new Error("The exact guest job was not found");
  return job;
}
/** Legacy records lack immutable participants/job binding. Export for manual recovery;
 * never delete, adopt a current announce address, or resume a wallet mutation from them. */
export function readLegacyGuestHire(storage: GuestJobStorage, guestPk: string): { raw: string; amount?: string; persona?: string; escrowAddress?: string } | undefined {
  if (!id(guestPk)) throw new Error("Invalid guest identity");
  const raw = storage.getItem(`fez-hire-${guestPk}`);
  if (raw === null) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { raw }; }
  return { raw, ...(object(value) ? {
    ...(typeof value.amount === "string" ? { amount: value.amount } : {}),
    ...(typeof value.persona === "string" ? { persona: value.persona } : {}),
    ...(object(value.escrow) && typeof value.escrow.addr === "string" ? { escrowAddress: value.escrow.addr } : {}),
  } : {}) };
}
function requireNoLegacy(storage: GuestJobStorage, scope: GuestJobScope): void {
  if (readLegacyGuestHire(storage, scope.guestPk)) throw new Error("Legacy hire needs manual recovery before new payments");
}
export function createGuestJob(storage: GuestJobStorage, scope: GuestJobScope, verifiedRequest: GuestJobRequest, terms: GuestJobTerms, now = Date.now()): GuestJob {
  scope = scopeOf(scope);
  validateJobTerms(terms as unknown as Record<string, unknown>);
  requireNoLegacy(storage, scope);
  const jobs = readGuestJobs(storage, scope);
  if (jobs.some(j => j.requestId === verifiedRequest.id)) throw new Error("This job already exists");
  if (jobs.some(j => !terminal(j))) throw new Error("An active job needs completion or recovery first");
  const job: GuestJob = { ...structuredClone(terms), version: 1, scope, ...requestFields(scope, verifiedRequest), at: now, state: "agreed" };
  return writeJob(storage, scope, job);
}
export function beginGuestPayment(storage: GuestJobStorage, scope: GuestJobScope, requestId: string, action: "pay" | "fund" | "release" | "refund", acceptedResultId?: string, now = Date.now()): GuestJob {
  requireNoLegacy(storage, scope);
  const lease = readGuestLease(storage, scope);
  if (lease && lease.state !== "confirmed") throw new Error("A lease payment is pending or unknown");
  const job = getJob(storage, scope, requestId);
  const allowed = action === "pay" ? job.kind === "settle" && job.state === "agreed" : action === "fund" ? job.kind === "escrow" && job.state === "agreed" : job.kind === "escrow" && job.state === "escrowed";
  if (!allowed) throw new Error(`Payment cannot start in job state ${job.state}`);
  if ((action === "pay" || action === "release") && !id(acceptedResultId)) throw new Error("Accept the exact verified result before paying");
  const states = { pay: "paying", fund: "funding", release: "releasing", refund: "refunding" } as const;
  return writeJob(storage, scope, { ...job, state: states[action], ...(acceptedResultId ? { acceptedResultId } : {}), updatedAt: now });
}
export function markGuestPaymentUnknown(storage: GuestJobStorage, scope: GuestJobScope, requestId: string): GuestJob {
  const job = getJob(storage, scope, requestId);
  if (!pending(job)) throw new Error("Only an in-progress payment can become unknown");
  return writeJob(storage, scope, { ...job, state: "unknown" });
}
export function finishGuestPayment(storage: GuestJobStorage, scope: GuestJobScope, requestId: string, output: unknown, now = Date.now()): GuestJob {
  const job = getJob(storage, scope, requestId);
  if (!["funding", "paying", "releasing", "refunding"].includes(job.state)) throw new Error("No pending payment can be confirmed in this state");
  try {
    if (!object(output) || !tx(output.txHash) || output.network !== "test") throw new Error();
    if (job.state === "paying") {
      if (output.persona !== job.persona || output.payerAddress !== job.payerAddress || output.to !== job.payTo || amount(output.amount) !== amount(job.amount)) throw new Error();
      return writeJob(storage, scope, { ...job, state: "paid", txHash: output.txHash, updatedAt: now });
    }
    if (!job.escrow || !address(output.escrow) || output.poster !== job.payerAddress || output.worker !== job.payTo ||
        output.arbiter !== job.escrow.arbiterAddress || amount(output.amount) !== amount(job.amount)) throw new Error();
    if (job.state === "funding") {
      if (output.payerAddress !== job.payerAddress) throw new Error();
      return writeJob(storage, scope, { ...job, state: "escrowed", escrow: { ...job.escrow, addr: output.escrow, fundingTxHash: output.txHash }, updatedAt: now });
    }
    if (output.payerAddress !== job.payerAddress && output.payerAddress !== job.escrow.arbiterAddress) throw new Error();
    if (output.escrow !== job.escrow.addr || output.executed !== true) throw new Error();
    return writeJob(storage, scope, { ...job, state: job.state === "releasing" ? "paid" : "refunded", txHash: output.txHash, updatedAt: now });
  } catch {
    writeJob(storage, scope, { ...job, state: "unknown", ...(object(output) && tx(output.txHash) ? { txHash: output.txHash } : {}) });
    throw new Error("Wallet outcome is not confirmed for this job; inspect it before recovery");
  }
}
export function cancelGuestJob(storage: GuestJobStorage, scope: GuestJobScope, requestId: string): GuestJob {
  const job = getJob(storage, scope, requestId);
  if (job.state !== "agreed") throw new Error("Cannot cancel a funded, pending or completed job state");
  return writeJob(storage, scope, { ...job, state: "cancelled" });
}

export function readGuestLease(storage: GuestJobStorage, scope: GuestJobScope): GuestLease | undefined {
  const raw = storage.getItem(leaseKey(scope));
  if (raw === null) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || !validBase(value, scope) || !time(value.paidThrough) || !["pending", "confirmed", "unknown"].includes(String(value.state))) throw new Error();
    validateLeaseTerms(value);
    if (value.state === "confirmed" && (!tx(value.txHash) || !id(value.receiptId))) throw new Error();
    return value as unknown as GuestLease;
  } catch { throw new Error("Stored lease state needs recovery; no payment was started"); }
}
export function beginGuestLease(storage: GuestJobStorage, scope: GuestJobScope, verifiedRequest: GuestJobRequest, quote: GuestLeaseTerms, now = Date.now()): GuestLease {
  scope = scopeOf(scope);
  validateLeaseTerms(quote as unknown as Record<string, unknown>);
  requireNoLegacy(storage, scope);
  if (readGuestJobs(storage, scope).some(pending)) throw new Error("A job payment is pending or unknown");
  const previous = readGuestLease(storage, scope);
  if (previous && previous.state !== "confirmed") throw new Error(`Lease payment is ${previous.state}; recovery is required`);
  const lease: GuestLease = { ...structuredClone(quote), version: 1, scope, ...requestFields(scope, verifiedRequest), at: now, state: "pending", paidThrough: previous?.paidThrough ?? 0 };
  storage.setItem(leaseKey(scope), JSON.stringify(lease));
  return lease;
}
export function markGuestLeaseUnknown(storage: GuestJobStorage, scope: GuestJobScope): GuestLease {
  const lease = readGuestLease(storage, scope);
  if (!lease || lease.state === "confirmed") throw new Error("No pending lease payment");
  const unknown: GuestLease = { ...lease, state: "unknown" };
  storage.setItem(leaseKey(scope), JSON.stringify(unknown));
  return unknown;
}
export function finishGuestLease(storage: GuestJobStorage, scope: GuestJobScope, output: unknown, now = Date.now()): GuestLease {
  const lease = readGuestLease(storage, scope);
  if (!lease || lease.state !== "pending") throw new Error("No pending lease payment can be confirmed");
  try {
    if (!object(output) || output.persona !== lease.persona || output.miner !== scope.guestPk || output.renterPubkey !== scope.ownerPk || output.hours !== lease.hours ||
        output.payerAddress !== lease.payerAddress || output.payTo !== lease.payTo || output.offerId !== lease.offerId ||
        output.rateTaoHr !== lease.rateTaoHr || output.network !== "test" || output.forEvent !== lease.requestId ||
        amount(output.amount) !== amount(lease.amount) || !tx(output.txHash) || !id(output.receiptId) || output.receiptPublished !== true ||
        typeof output.paidHours !== "number" || !Number.isFinite(output.paidHours) || output.paidHours <= 0 || output.paidHours > lease.hours) throw new Error();
    const done: GuestLease = { ...lease, state: "confirmed", txHash: output.txHash, receiptId: output.receiptId,
      paidThrough: Math.max(now, lease.paidThrough) + Math.floor(output.paidHours * 3_600_000) };
    storage.setItem(leaseKey(scope), JSON.stringify(done));
    return done;
  } catch {
    storage.setItem(leaseKey(scope), JSON.stringify({ ...lease, state: "unknown", ...(object(output) && tx(output.txHash) ? { txHash: output.txHash } : {}) }));
    throw new Error("Lease outcome or receipt is not confirmed; inspect it before recovery");
  }
}
