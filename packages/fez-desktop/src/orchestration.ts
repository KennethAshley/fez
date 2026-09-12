/**
 * The orchestration corpus, v1 (spec 2026-09-04): every market proposal
 * @fez makes, what the human decided, and what actually happened. This is
 * the training data the router eventually becomes — logged LOCALLY only
 * (it contains the user's task text); export is a later, opt-in act.
 * Storage: the extension-storage blob "orchestration" as {records: [...]}
 * — read-modify-write, small records, no new Rust. On disk this lands as
 * prefs.records.{records: [...]} — extension-storage wraps every key under
 * "prefs", so tauriStore unwraps one extra layer on read (see below).
 * ponytail: unbounded array; rotate/export when it measurably matters.
 */
import { invoke } from "@tauri-apps/api/core";

export interface OrchestrationRecord {
  id: string;
  ts: string;
  task: string;
  roster: string[];
  picked: { pk: string; name: string; rateTaoHr?: number; judged?: number; meanScore?: number; paidHires?: number };
  why: string;
  kind: string;
  priceEstTao?: number;
  decision: "pending" | "accepted" | "declined";
  sentTaskId?: string;
  outcome?: { delivered: boolean; latencyS?: number };
  /** What was actually paid, once a settle or escrow release closes the
   *  hire — the corpus's other half of "accepted": not just that a human
   *  said yes, but what it cost. */
  hire?: { kind: string; paid: string; txHash: string };
}

export type ReadFn = () => Promise<string | undefined>;
export type WriteFn = (content: string) => Promise<void>;

async function load(read: ReadFn): Promise<OrchestrationRecord[]> {
  try {
    const blob = await read();
    const parsed = JSON.parse(blob ?? "{}") as { records?: OrchestrationRecord[] };
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch { return []; } // a corrupt blob must not brick proposals
}

const save = (write: WriteFn, records: OrchestrationRecord[]) =>
  write(JSON.stringify({ records }));

export async function recordProposal(
  read: ReadFn, write: WriteFn,
  rec: Omit<OrchestrationRecord, "id" | "ts" | "decision">
): Promise<string> {
  const records = await load(read);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  records.push({ ...rec, id, ts: new Date().toISOString(), decision: "pending" });
  await save(write, records);
  return id;
}

export async function updateRecord(read: ReadFn, write: WriteFn, id: string, patch: Partial<OrchestrationRecord>): Promise<void> {
  const records = await load(read);
  const i = records.findIndex((r) => r.id === id);
  if (i < 0) return; // an unknown id is a no-op, never a throw mid-UI
  records[i] = { ...records[i], ...patch };
  await save(write, records);
}

export async function latestPendingFor(read: ReadFn, pk: string): Promise<OrchestrationRecord | undefined> {
  const records = await load(read);
  return [...records].reverse().find((r) => r.picked.pk === pk && r.decision === "pending")
    ?? [...records].reverse().find((r) => r.picked.pk === pk && r.decision === "accepted" && !r.outcome);
}

/** The record a payment should attach to: newest for this candidate that
 *  has a sent task but no recorded hire yet. `latestPendingFor` is shaped
 *  for the "still deciding / delivered?" callers and can skip past a
 *  record that's already been sent — this is the narrower lookup the
 *  settle/escrow sites need. */
export async function latestSentFor(read: ReadFn, pk: string): Promise<OrchestrationRecord | undefined> {
  const records = await load(read);
  return [...records].reverse().find((r) => r.picked.pk === pk && r.sentTaskId && !r.hire);
}

/** Payment and delivery belong to the agreed task, even after a newer proposal. */
export async function findByTask(read: ReadFn, pk: string, taskId: string): Promise<OrchestrationRecord | undefined> {
  return (await load(read)).find((record) => record.picked.pk === pk && record.sentTaskId === taskId);
}

/** The latest record for exactly this proposal (same candidate, same task
 *  text) — how a remounted card recovers its decided state instead of
 *  re-offering buttons and double-logging. */
export async function findByProposal(read: ReadFn, pk: string, task: string): Promise<OrchestrationRecord | undefined> {
  const records = await load(read);
  return [...records].reverse().find((r) => r.picked.pk === pk && r.task === task);
}

/** Real callers' store: the extension-storage blob named "orchestration". */
export const tauriStore = {
  read: (async () => {
    try {
      const blob = await invoke<string>("extension_storage_read", { name: "orchestration" });
      // The Rust backend stores under prefs, so extract: data.prefs.records is the blob object
      const data = JSON.parse(blob ?? "{}") as any;
      const records = data.prefs?.records;
      if (records) {
        // Stringify back to match the ReadFn contract (returns JSON string)
        return JSON.stringify(records);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }) as ReadFn,
  write: (async (content: string) => {
    // extension_storage_write stores value (a JSON string) under state["prefs"][key]
    // We pass the blob content which is JSON.stringify({ records: [...] })
    // Result: state["prefs"]["records"] = { records: [...] } (as parsed JSON object)
    await invoke("extension_storage_write", { name: "orchestration", key: "records", value: content });
  }) as WriteFn,
};
