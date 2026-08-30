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
