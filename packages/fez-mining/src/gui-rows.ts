import type { Subnet } from "@fezchat/bittensor/subnets";
import type { ConfigField, SubmissionStatus } from "@fezchat/extension-api";

export function submissionVersions(status?: SubmissionStatus) {
  const versions = status?.versions ?? [];
  return {
    latest: versions.reduce<(typeof versions)[number] | undefined>((latest, v) => !latest || v.version > latest.version ? v : latest, undefined),
    active: versions.find(v => v.id === status?.activeVersionId),
  };
}

export type ConfigFormValues = Record<string, string | number | boolean>;

// Targon-class hardware-gated netuids — descriptor-declared flag can
// replace this hardcoded list later.
export const HARDWARE_GATED: number[] = [4];

/**
 * Release freeze (2026-09-09, ship-week call): descriptors that exist but
 * are not offered yet. Gradients waits on its published image — the
 * placeholder digest would fail at pull, and an erroring tile is not a
 * release look. Distinct from HARDWARE_GATED, which states a hardware
 * truth; this states a readiness truth. Unfreeze = delete the netuid here
 * (and paste the real image digest in fez-gradients).
 */
export const RELEASE_FROZEN: number[] = [56];

export type MachineChoice = "local" | "lium" | "ssh" | "do";

/**
 * Which machine kinds a descriptor's requirements permit, pure. No
 * requirement → local only (v1 flow, no picker shown). A GPU floor or a
 * public-endpoint need both rule out a NAT'd local Mac, but for different
 * reasons — surfaced separately so the GUI's disabled-option tooltip is
 * accurate. ssh (a host you already run) is offered for BOTH remote
 * needs — the user may own the right hardware, and refusing them the
 * option is paternalism, not honesty. Honesty lives in the label: a GPU
 * floor fez cannot verify on an owned box is stated on the choice, and
 * the informed pick is the user's.
 */
export function machineChoices(
  req: { gpu?: string; publicEndpoint?: boolean } | undefined,
  hasDoToken: boolean
): { choice: MachineChoice; enabled: boolean; reason?: string }[] {
  if (!req?.gpu && !req?.publicEndpoint) return [{ choice: "local", enabled: true }];
  const reason = req.gpu
    ? `needs a ${req.gpu} GPU`
    : "validators must reach this miner — your Mac has no public port";
  return [
    { choice: "local", enabled: false, reason },
    {
      choice: "ssh",
      enabled: true,
      reason: req.gpu
        ? `your own GPU server — it must actually have a ${req.gpu} GPU; fez can't check, and without one the miner earns nothing`
        : "a public host you already run",
    },
    { choice: "lium", enabled: true },
    {
      choice: "do" as const,
      enabled: hasDoToken,
      reason: hasDoToken
        ? "fez makes a DigitalOcean droplet (~$0.018/hr, billed to your DO account until stop)"
        : "add DO_API_TOKEN in SKILLS & SECRETS to let fez make the machine for you",
    },
  ];
}

/**
 * Pure row-model for the subnets list — no DOM, so vitest needs nothing
 * beyond plain Node to exercise it. Covered (curated-miner) subnets sort
 * first; within each group, ascending netuid. `gated` netuids (hardware
 * requirements not yet supported on any machine) render a badge instead
 * of a Mine button.
 */
/**
 * The subnet-stacking story, pure: which OTHER subnets a miner composes with
 * to mine this one ("mine Bittensor with Bittensor"). Two sources — a
 * curated map for descriptor-level composition the requirements can't
 * express (Bazaar answers through a Chutes LLM key), and a derivation for
 * machine needs (a GPU floor or public endpoint is met by renting a Lium
 * pod). Returned as netuids so the GUI renders each component with its own
 * subnet badge.
 */
export const LIUM_NETUID = 51;
export const CHUTES_NETUID = 64;
const CURATED_STACK: Record<number, number[]> = {
  553: [CHUTES_NETUID], // Bazaar — answers priced through a Chutes inference key
};
export function stackFor(netuid: number, req?: { gpu?: string; publicEndpoint?: boolean }): number[] {
  const curated = CURATED_STACK[netuid] ?? [];
  const machine = req?.gpu || req?.publicEndpoint ? [LIUM_NETUID] : [];
  return [...curated, ...machine];
}

export function subnetRows(subnets: Subnet[], covered: number[], gated: number[] = [], frozen: number[] = []) {
  return subnets
    .map((s) => ({
      ...s,
      curated: covered.includes(s.netuid),
      gated: gated.includes(s.netuid),
      frozen: frozen.includes(s.netuid),
    }))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || a.netuid - b.netuid);
}

/**
 * Seed values for the New-miner config form, pure. Non-secret fields start
 * at their schema default (omitted when there isn't one — an uncontrolled
 * field renders blank). Secrets NEVER seed from a default (there isn't one
 * in the schema anyway — the value lives in the keychain, not here) and
 * always start blank, so a re-opened form can't leak or restate a stored
 * secret onto the screen.
 */
export function initialFormValues(schema: ConfigField[]): ConfigFormValues {
  const out: ConfigFormValues = {};
  for (const f of schema) {
    if (f.type === "secret") {
      out[f.key] = "";
      continue;
    }
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
