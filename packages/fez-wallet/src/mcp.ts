#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { pairFromStored, evmPairFromStored } from "./derive.js";
import { readEntry, readAgentNostrKey } from "./store.js";
import { isValidEntryName, isReservedEntryName } from "./entry-names.js";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import { evmAdapter } from "./chains/evm.js";
import { poolRelay } from "./consent.js";
import {
  walletAddress,
  walletBalance,
  walletSend,
  walletHistory,
  x402Fetch,
  makeX402Deps,
  type ToolDeps,
} from "./tools.js";
import type { ChainAdapter } from "./chains/adapter.js";
import type { WalletPair, EvmPair } from "./derive.js";
import type { WalletConfig } from "./config.js";
import { personaStatus, stakePersona, unstakePersona, escrowApprove, escrowStatus } from "./stake.js";
import { rentAgent } from "./rent.js";
import { resolveRecipient } from "./resolve.js";
import { rosterFilter, rosterFromEvents } from "./roster.js";
import { createAddressAnnouncer } from "./announce.js";

/**
 * fez-wallet, skill part — the calling agent's OWN allowance account.
 *
 * Identity comes from FEZ_AGENT_PERSONA (set by fez-acp in the harness
 * env), NEVER from tool arguments: this process can only ever load one
 * derived key, and the root mnemonic entry is not referenced anywhere
 * in this import graph (spec invariants 1 and 2) — this file imports
 * readEntry/readAgentNostrKey only, never readRootEntry/writeRootEntry.
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-wallet: FEZ_AGENT_PERSONA is not set — this skill only runs inside an agent harness.");
  process.exit(1);
}
if (!isValidEntryName(persona) || isReservedEntryName(persona)) {
  console.error(`fez-wallet: FEZ_AGENT_PERSONA "${persona}" is not a usable persona name.`);
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = new McpServer({ name: "fez-wallet", version: "0.1.0" });

/** Chain adapters are memoized by endpoint at module scope (finding #4):
 * deps() used to build a fresh substrateAdapter — and so a fresh
 * ApiPromise/WsProvider — on every single tool call, leaking one
 * connection per call. The adapter object now persists across calls;
 * substrateAdapter's own internal connection memo resets itself only on
 * a failed connect, so a bad endpoint still gets retried next time. */
const substrateAdapters = new Map<string, ChainAdapter>();
function cachedSubstrateAdapter(endpoint: string): ChainAdapter {
  let a = substrateAdapters.get(endpoint);
  if (!a) {
    a = substrateAdapter({ endpoint });
    substrateAdapters.set(endpoint, a);
  }
  return a;
}
const evm = evmAdapter(); // stateless stub — one instance is plenty

/** Addressable, so republishing is a replace and needs no staleness
 * bookkeeping. Failure is silent by design — an agent that cannot
 * announce where to be paid must still be able to pay. Called unawaited
 * from deps() (never at startup — that's the @polkadot handshake trap
 * fez-bittensor already paid for) and guarded, per chain+network, to run
 * at most once per process: a network flip mid-process has its own
 * announce to make (announce.ts). */
const announceAddress = createAddressAnnouncer();
async function publishOwnAddress(
  config: WalletConfig,
  pair: WalletPair,
  adapter: ChainAdapter,
  relays: string[],
  agentNostrKey: string | undefined
) {
  if (!relays.length || !agentNostrKey) return;
  await announceAddress({
    agentSecretHex: agentNostrKey,
    chain: adapter.chain,
    network: config.network,
    address: adapter.address(pair),
    publish: async (ev) => {
      const relay = await poolRelay(relays, agentNostrKey);
      await relay.publish(ev);
    },
  });
}

/** Deps are built lazily per call: config edits and newly derived keys
 * apply without restarting the agent, and startup stays instant for the
 * MCP handshake. `signal` carries the MCP request's AbortSignal through
 * to walletSend (finding #6). */
async function deps(signal?: AbortSignal): Promise<ToolDeps> {
  await cryptoWaitReady();
  const stored = readEntry(persona!);
  if (!stored) {
    throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  }
  const config = loadConfig();
  const pair = pairFromStored(stored);
  // Threaded in opportunistically (I5): `wallet_address --chain eth` /
  // `wallet_balance --chain eth` hand this same pair to the evm adapter,
  // which needs the `.evm` branch. A pre-EVM entry (no `.evm` stored yet)
  // just leaves it off — evm.ts's address() throws its own friendly
  // error in that case rather than a raw TypeError.
  let pairWithEvm: WalletPair & { evm?: EvmPair } = pair;
  try {
    pairWithEvm = { ...pair, evm: evmPairFromStored(stored) };
  } catch {
    // No EVM branch on this entry yet — eth-chain calls explain themselves.
  }
  const relays = (process.env.FEZ_RELAY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const agentNostrKey = readAgentNostrKey(persona!);
  const substrate = cachedSubstrateAdapter(config.endpoints.tao);

  void publishOwnAddress(config, pair, substrate, relays, agentNostrKey);

  return {
    persona: persona!,
    pair: pairWithEvm,
    adapters: [substrate, evm],
    config,
    ownerPk: process.env.FEZ_AGENT_OWNER,
    agentNostrKey,
    // The agent's nostr key doubles as the NIP-42 auth identity —
    // membership-gated relays withhold reads from anonymous connections.
    relay: relays.length ? () => poolRelay(relays, agentNostrKey) : undefined,
    // Name → address resolution needs a relay to read the roster and
    // published address events from; with none configured this degrades
    // to undefined, and walletSend falls back to its local-only resolveTo.
    resolve: relays.length
      ? async (to: string) => {
          const relay = await poolRelay(relays, agentNostrKey);
          return resolveRecipient(to, {
            chain: "tao",
            network: config.network,
            // Unscoped by the kind's own shape — see roster.ts, and do
            // not put the consent channel back into this filter.
            roster: async () => rosterFromEvents(await relay.query(rosterFilter())),
            addressEvents: (filter) => relay.query(filter),
            localAddress: (n) => {
              if (!isValidEntryName(n) || isReservedEntryName(n)) return undefined;
              const stored = readEntry(n);
              return stored ? pairFromStored(stored).address : undefined;
            },
          });
        }
      : undefined,
    signal,
  };
}

server.registerTool(
  "wallet_address",
  {
    description: "Your own receive address — where someone sends you money. Currently TAO (bittensor).",
    inputSchema: { chain: z.string().optional().describe("Chain id, e.g. 'tao'. Default: the first enabled chain.") },
  },
  async ({ chain }) => text(walletAddress(await deps(), { chain }))
);

server.registerTool(
  "wallet_balance",
  {
    description: "Your current balance. This balance IS your spending cap — there is no other budget.",
    inputSchema: {
      chain: z.string().optional().describe("Chain id, e.g. 'tao'."),
      asset: z.string().optional().describe("Asset symbol, e.g. 'TAO'."),
    },
  },
  async ({ chain, asset }) => text(await walletBalance(await deps(), { chain, asset }))
);

server.registerTool(
  "wallet_send",
  {
    description:
      "Send money from your allowance. Small amounts go through immediately; larger amounts post a consent request to the owner and wait up to 10 minutes for their ✅ — you'll be told the outcome either way.",
    inputSchema: {
      to: z.string().describe("Destination: a raw address, or a local persona name (e.g. 'vault')."),
      amount: z.string().describe("Decimal amount, e.g. '0.05'."),
      asset: z.string().describe("Asset symbol, e.g. 'TAO'."),
      memo: z.string().optional().describe("Short human-readable reason — shown in the consent request."),
      for: z
        .string()
        .optional()
        .describe("Id of the message this pays for — the payment shows under it in chat."),
    },
  },
  async ({ to, amount, asset, memo, for: forEvent }, extra) =>
    text(await walletSend(await deps(extra.signal), { to, amount, asset, memo, for: forEvent }))
);

server.registerTool(
  "x402_fetch",
  {
    description:
      "Fetch a URL. If (and only if) the server answers 402 Payment Required, pay for it in USDC — up to maxUsd, and only after the same consent/cap checks wallet_send uses. Never pays twice for one call, even if the paid retry fails or demands payment again.",
    inputSchema: {
      url: z.string().describe("The URL to fetch."),
      method: z.string().optional().describe("HTTP method, default GET."),
      body: z.string().optional().describe("Request body, if any."),
      maxUsd: z.number().describe("Required. The most you're willing to pay for this call, in USD."),
    },
  },
  async ({ url, method, body, maxUsd }, extra) =>
    text(await x402Fetch(await makeX402Deps(persona!, extra.signal), { url, method, body, maxUsd }))
);

/* ── the stake rehearsal, agent-side ──────────────────────────────────
 * Self-stake is the agent's own account staking to its own hotkey: the
 * money stays under this persona's key and unstake reverses it, so no
 * consent card — unlike wallet_send, nothing leaves the agent's custody.
 * The write verbs refuse mainnet inside stake.ts (testnet rehearsal
 * only), which is also why skipping consent is currently safe.
 * ponytail: before mainnet enablement, self-stake gets a consent story. */

server.registerTool(
  "wallet_stake",
  {
    description:
      "Stake part of your own balance behind your own miner hotkey on the subnet — your earnings, staked behind your name. Testnet-only for now; the money stays yours and wallet_unstake reverses it.",
    inputSchema: {
      amount: z.string().describe("Decimal TAO amount to stake, e.g. '0.5'."),
      netuid: z.number().optional().describe("Subnet netuid (default 553)."),
    },
  },
  async ({ amount, netuid }) => {
    await cryptoWaitReady();
    const r = await stakePersona(persona!, amount, netuid);
    return text(`staked ${r.amount} tTAO to your own hotkey on netuid ${r.netuid} (tx ${r.txHash})`);
  }
);

server.registerTool(
  "wallet_unstake",
  {
    description: "Unstake alpha from your own hotkey back to your free balance. Testnet-only for now.",
    inputSchema: {
      amount: z.string().describe("Decimal alpha amount to unstake, e.g. '0.5'."),
      netuid: z.number().optional().describe("Subnet netuid (default 553)."),
    },
  },
  async ({ amount, netuid }) => {
    await cryptoWaitReady();
    const r = await unstakePersona(persona!, amount, netuid);
    return text(`unstaked ${r.amount} tα from your hotkey on netuid ${r.netuid} (tx ${r.txHash})`);
  }
);

server.registerTool(
  "wallet_rent",
  {
    description:
      "Rent another agent's attention on the bazaar: pay its announced hourly rate from YOUR allowance. " +
      "One call buys `hours` of priority — your directed asks (bazaar_ask with `to`) jump its queue while paid. " +
      "Prepaid and unilateral: stopping is just not renting again; you risk exactly what one call pays. Testnet-only for now.",
    inputSchema: {
      miner: z.string().regex(/^[0-9a-f]{64}$/).describe("The agent to rent: its nostr pubkey (hex), from the bazaar directory."),
      hours: z.number().min(0.05).max(24).describe("How long to rent. Cost = hours × its announced tao_hr rate."),
    },
  },
  async ({ miner, hours }) => {
    await cryptoWaitReady();
    const r = await rentAgent(persona!, miner, hours);
    return text(
      `rented ${miner.slice(0, 8)} for ${r.hours}h at its announced rate — paid ${r.amount} tTAO from your allowance (tx ${r.txHash}). ` +
        `Your directed asks get priority while the lease runs; it lapses on its own, nothing to cancel.`
    );
  }
);

server.registerTool(
  "wallet_escrow_release",
  {
    description:
      "Claim your pay from an escrowed hire, or check what one holds. When a poster hires you through a 2-of-3 escrow and you've delivered, approve the release to yourself — when the poster has also approved, the funds move to you. Nobody can take the money alone; two of {poster, you, arbiter} must agree. Testnet-only for now.",
    inputSchema: {
      poster: z.string().describe("The hirer's ss58 address (funded the escrow)."),
      arbiter: z.string().describe("The arbiter's ss58 address named on the hire."),
      amount: z.string().describe("The escrowed amount, e.g. '0.5' — must match what was opened, byte for byte."),
      check_only: z.boolean().optional().describe("Just read what the escrow holds, don't approve anything."),
    },
  },
  async ({ poster, arbiter, amount, check_only }) => {
    await cryptoWaitReady();
    const me = (await personaStatus(persona!)).address;
    if (check_only) {
      const s = await escrowStatus(poster, me, arbiter);
      return text(`escrow ${s.escrow} holds ${s.heldTao} tTAO`);
    }
    const r = await escrowApprove(persona!, poster, me, arbiter, amount, "worker");
    return text(
      r.executed
        ? `escrow released — ${amount} tTAO is yours now (tx ${r.txHash})`
        : `your approval is recorded; the poster must also release for the funds to move (tx ${r.txHash})`
    );
  }
);

server.registerTool(
  "wallet_stake_status",
  {
    description: "Your subnet standing: registered uid (or not), free balance, and how much is staked behind your hotkey.",
    inputSchema: { netuid: z.number().optional().describe("Subnet netuid (default 553).") },
  },
  async ({ netuid }) => {
    await cryptoWaitReady();
    const s = await personaStatus(persona!, netuid);
    const t = s.network === "finney" ? "" : "t";
    return text(
      `${s.persona} on netuid ${s.netuid}: ${s.uid !== undefined ? `uid ${s.uid}` : "not registered (ask your owner to register you)"} · ` +
        `free ${s.free} ${t}TAO · staked ${s.staked !== undefined ? `${s.staked} ${t}α` : "unknown"}`
    );
  }
);

server.registerTool(
  "wallet_history",
  {
    description: "Your recent transfers (from this machine's spend log).",
    inputSchema: { limit: z.number().optional().describe("Max rows (default 20).") },
  },
  async ({ limit }) => text(await walletHistory(await deps(), { limit }))
);

await server.connect(new StdioServerTransport());
console.error(`fez-wallet ready — allowance account for "${persona}"`);
