import type { ApiPromise } from "@polkadot/api";

/**
 * fez-bittensor discovery — chain-direct subnet listing, no spend.
 *
 * Read-only. Answers what subnets exist, what each one does, and where its
 * code is. Straight from the chain (@polkadot/api against finney) —
 * sovereign, no third-party API, no key — with an optional Taostats
 * fallback only to fill an identity a subnet owner never committed
 * on-chain.
 */

const FINNEY = process.env.FEZ_BITTENSOR_RPC || "wss://entrypoint-finney.opentensor.ai:443";
const TAOSTATS_KEY = process.env.TAOSTATS_API_KEY;

/** Chain identity fields are hex-encoded UTF-8 (0x…); decode to text. */
function hexToStr(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("0x")) return "";
  try {
    return Buffer.from(v.slice(2), "hex").toString("utf8").trim();
  } catch {
    return "";
  }
}

export interface Subnet {
  netuid: number;
  name: string;
  description?: string;
  github?: string;
}

let apiPromise: Promise<ApiPromise> | undefined;
function chain(): Promise<ApiPromise> {
  if (!apiPromise) {
    // Dynamic import so the heavy @polkadot/api graph (WASM crypto init)
    // loads on the first query, not at process start — the MCP handshake
    // must answer instantly or a host (claude-code) gives up attaching it.
    apiPromise = import("@polkadot/api").then(({ ApiPromise, WsProvider }) =>
      ApiPromise.create({ provider: new WsProvider(FINNEY), noInitWarn: true })
    );
  }
  return apiPromise;
}

/** Pure: one chain identity record → a Subnet row. Exported for tests. */
export function subnetFromIdentity(netuid: number, id: Record<string, unknown>): Subnet {
  return {
    netuid,
    name: hexToStr(id.subnetName) || `subnet ${netuid}`,
    description: hexToStr(id.description) || undefined,
    github: hexToStr(id.githubRepo) || undefined,
  };
}

/** Every registered subnet with whatever identity its owner committed. One
 * multi-query for the netuid list, one for all identities — no N+1. */
export async function allSubnets(): Promise<Subnet[]> {
  const api = await chain();
  const st = api.query.subtensorModule;
  const added = await st.networksAdded.entries();
  const netuids = added
    .filter(([, v]) => v.toJSON() === true)
    .map(([k]) => (k.args[0] as unknown as { toNumber(): number }).toNumber())
    .sort((a, b) => a - b);
  const identities = await st.subnetIdentitiesV3.multi(netuids);
  const subnets: Subnet[] = netuids.map((netuid, i) => {
    const id = (identities[i]?.toJSON() ?? {}) as Record<string, unknown>;
    return subnetFromIdentity(netuid, id);
  });
  return maybeEnrich(subnets);
}

/** Fill blank name/github from Taostats — only when a key is set and the
 * chain had nothing. Chain is the source of truth; this is a courtesy. */
export async function maybeEnrich(subnets: Subnet[]): Promise<Subnet[]> {
  if (!TAOSTATS_KEY) return subnets;
  const missing = subnets.filter((s) => !s.github || s.name.startsWith("subnet "));
  if (missing.length === 0) return subnets;
  try {
    const res = await fetch("https://api.taostats.io/api/subnet/latest/v1?limit=256", {
      headers: { Authorization: TAOSTATS_KEY, accept: "application/json" },
    });
    if (!res.ok) return subnets;
    const json = (await res.json()) as { data?: { netuid?: number; name?: string; github_repo?: string; description?: string }[] };
    const byId = new Map((json.data ?? []).map((d) => [d.netuid, d]));
    for (const s of subnets) {
      const t = byId.get(s.netuid);
      if (!t) continue;
      if (s.name.startsWith("subnet ") && t.name) s.name = t.name;
      if (!s.github && t.github_repo) s.github = t.github_repo;
      if (!s.description && t.description) s.description = t.description;
    }
  } catch {
    /* Taostats is a courtesy — never let it fail the chain answer. */
  }
  return subnets;
}
