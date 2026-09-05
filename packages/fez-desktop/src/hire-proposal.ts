/**
 * @fez's hire proposal, parsed with total suspicion: the block arrives in
 * a model's reply, so any malformed field means NO card — a proposal that
 * can't be fully validated renders as nothing at all. The model proposes;
 * only the card's button (a human act) disposes.
 */
export interface HireProposal {
  task: string;
  pk: string;
  name: string;
  why: string;
  kind: "settle" | "lease" | "escrow";
  priceEstTao?: number;
  rateTaoHr?: number;
}

const KINDS = new Set(["settle", "lease", "escrow"]);

export function parseHireProposal(fenceText: string): HireProposal | undefined {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(fenceText) as Record<string, unknown>; } catch { return undefined; }
  const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const task = s(raw.task), pk = s(raw.pk), name = s(raw.name), why = s(raw.why), kind = s(raw.kind);
  if (!task || !pk || !name || !why || !kind) return undefined;
  if (!/^[0-9a-f]{64}$/.test(pk)) return undefined;
  if (!KINDS.has(kind)) return undefined;
  if (task.length > 4000 || why.length > 1000 || name.length > 64) return undefined;
  return {
    task, pk, name, why, kind: kind as HireProposal["kind"],
    ...(n(raw.price_est_tao) !== undefined ? { priceEstTao: n(raw.price_est_tao) } : {}),
    ...(n(raw.rate_tao_hr) !== undefined ? { rateTaoHr: n(raw.rate_tao_hr) } : {}),
  };
}
