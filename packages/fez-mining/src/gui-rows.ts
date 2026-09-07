import type { Subnet } from "@fezchat/bittensor/subnets";

/**
 * Pure row-model for the subnets list — no DOM, so vitest needs nothing
 * beyond plain Node to exercise it. Covered (curated-miner) subnets sort
 * first; within each group, ascending netuid.
 */
export function subnetRows(subnets: Subnet[], covered: number[]) {
  return subnets
    .map((s) => ({ ...s, curated: covered.includes(s.netuid) }))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || a.netuid - b.netuid);
}
