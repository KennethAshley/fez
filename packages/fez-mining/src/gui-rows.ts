import type { Subnet } from "@fezchat/bittensor/subnets";

// Targon-class hardware-gated netuids — descriptor-declared flag can
// replace this hardcoded list later.
export const HARDWARE_GATED: number[] = [4];

export type MachineChoice = "local" | "lium";

/**
 * Which machine kinds a descriptor's requirements permit, pure. No
 * requirement → local only (v1 flow, no picker shown). A GPU floor or a
 * public-endpoint need both rule out a NAT'd local Mac, but for different
 * reasons — surfaced separately so the GUI's disabled-option tooltip is
 * accurate.
 */
export function machineChoices(
  req: { gpu?: string; publicEndpoint?: boolean } | undefined
): { choice: MachineChoice; enabled: boolean; reason?: string }[] {
  if (!req?.gpu && !req?.publicEndpoint) return [{ choice: "local", enabled: true }];
  const reason = req.gpu
    ? `needs a ${req.gpu} GPU`
    : "validators must reach this miner — your Mac has no public port";
  return [
    { choice: "local", enabled: false, reason },
    { choice: "lium", enabled: true },
  ];
}

/**
 * Pure row-model for the subnets list — no DOM, so vitest needs nothing
 * beyond plain Node to exercise it. Covered (curated-miner) subnets sort
 * first; within each group, ascending netuid. `gated` netuids (hardware
 * requirements not yet supported on any machine) render a badge instead
 * of a Mine button.
 */
export function subnetRows(subnets: Subnet[], covered: number[], gated: number[] = []) {
  return subnets
    .map((s) => ({ ...s, curated: covered.includes(s.netuid), gated: gated.includes(s.netuid) }))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || a.netuid - b.netuid);
}
