# @fezchat/wallet — per-agent allowance wallets

**Date:** 2026-08-25 · **Status:** approved design, pre-implementation

## Purpose

Give each fez agent its own spendable crypto allowance — funded from a
single master mnemonic Ken controls — so agents can pay for inference
(Chutes), tip other agents, and later cover their own bazaar miner
registration. TAO ships live in v1; the agent-facing surface is
chain-agnostic so ETH/USDC land later without touching it.

## The pattern

Two trees, one treasury:

- **Money tree (this extension):** one BIP-39 mnemonic → hard-derived
  per-agent accounts (`//<persona>`). The balance on an agent's account
  *is* its spending cap — the envelope model. All funding flows down
  from the mnemonic's base account (the treasury); nothing an agent
  does can reach a sibling's key or the root.
- **Identity tree (existing):** agent npubs in keychain `fez-keys`.
  Deliberately a *separate* compromise domain — stealing an agent's
  machine yields one warm npub and one small allowance, never both
  trees.

## Package shape

`packages/fez-wallet`, npm `@fezchat/wallet`, modeled on
`fez-bittensor`:

```jsonc
{
  "name": "@fezchat/wallet",
  "bin": { "fez-wallet": "dist/cli.js" },       // → ~/.fez/bin
  "fez": {
    "type": "extension",
    "parts": { "skill": { "command": "node", "args": ["dist/mcp.js"] } },
    "permissions": [
      "network:entrypoint-finney.opentensor.ai",
      "network:relay",
      "publish"
    ],
    "minFezVersion": "0.2.0"
  }
}
```

Build: esbuild bundle (same script shape as fez-bittensor), `tsc
--noEmit` check. Deps: `@polkadot/api`, `@polkadot/keyring`,
`@polkadot/util-crypto`, `@modelcontextprotocol/sdk`, `zod`.

## Key custody

Keychain service **`fez-wallet`** (macOS keychain, `security` CLI —
same access pattern as `fez-keys`, but a distinct service so money and
identity never share a grant):

| entry | contents | who reads it |
|---|---|---|
| `fez-wallet/root` | BIP-39 mnemonic (24 words) | `fez-wallet` CLI ceremony ONLY |
| `fez-wallet/<persona>` | sr25519 seed for `//<persona>` | that agent's MCP server ONLY |

**Derivation.** Substrate hard derivation `//<persona>` from the root
mnemonic (sr25519, `@polkadot/keyring`). EVM (later): same mnemonic at
BIP-44 `m/44'/60'/0'/0/<index>`, secp256k1; the persona→index map
lives in config so paths are stable forever once assigned.

**Runtime identity.** The MCP server reads `FEZ_AGENT_PERSONA` from its
environment (set by fez-acp in every agent harness) at startup and
loads only `fez-wallet/${FEZ_AGENT_PERSONA}`. Tool arguments never
select the key.

## Chain adapter

`src/chains/adapter.ts`:

```ts
interface Amount { raw: bigint; decimals: number; symbol: string }
interface ChainAdapter {
  chain: "tao" | "eth";
  assets: { symbol: string; decimals: number }[];
  address(seed: Uint8Array): string;
  balance(address: string, asset: string): Promise<Amount>;
  transfer(seed: Uint8Array, to: string, amount: Amount, asset: string): Promise<{ txHash: string }>;
}
```

- `src/chains/substrate.ts` — implemented. `@polkadot/api` against
  finney (`entrypoint-finney.opentensor.ai`), transfers via
  `balances.transferKeepAlive` (never reap an allowance account).
  Endpoint overridable in config for testnet.
- `src/chains/evm.ts` — present and registered; every method throws
  `NotEnabledError("evm support lands in a later release")`. Its
  existence pins the adapter interface so enabling it never changes
  agent-facing tools.

## MCP tools (agent-facing)

All tools operate on the calling agent's own account only.

| tool | args | behavior |
|---|---|---|
| `wallet_address` | `{chain?}` | this agent's receive address(es) |
| `wallet_balance` | `{chain?, asset?}` | balances across enabled chains |
| `wallet_send` | `{to, amount, asset, memo?}` | consent-gated transfer (below) |
| `wallet_history` | `{limit?}` | recent transfers this server executed (local log) |

`to` accepts a raw address or a local persona name (resolved to that
persona's derived address from config). `wallet_history` is the MCP
server's own append-only log (`~/.fez/wallet-log.jsonl`), not chain
archaeology — good enough for "what did I spend."

## Consent flow

Config `~/.fez/wallet.json`:

```jsonc
{
  "thresholds": { "default": "0.01", "scout": "0.05" },  // in TAO
  "consentChannel": "<channelId>",     // where requests are posted
  "personas": { "scout": { "index": 0 } },               // EVM path registry
  "endpoints": { "tao": "wss://entrypoint-finney.opentensor.ai:443" }
}
```

- **Under threshold:** execute immediately, log, return txHash.
- **Over threshold:** publish a kind **47103** channel message p-tagging
  the workspace owner — `"scout requests 0.5 TAO → 5F3s… (memo)"` —
  then subscribe for a **kind 7 reaction** targeting that event and
  signed by the owner npub: ✅ → execute; ❌ → return declined;
  **10-minute timeout** → declined. The tool call blocks meanwhile and
  reports the outcome to the agent.

No new event kinds: requests render in every existing client, and the
authorization primitive is the owner's signature on a reaction e-tagging
the request event — the same trust rule the rest of fez uses
(owner-signed = authoritative). A dedicated kind is a later option if
consent traffic pollutes channels.

## CLI ceremony (`fez-wallet`)

| command | behavior |
|---|---|
| `init` | generate 24-word mnemonic, print ONCE for paper backup (never logged), store `fez-wallet/root`, write config skeleton. Refuses if root exists. |
| `derive <persona>` | derive `//<persona>`, store keychain entry, assign next EVM index in config, print address |
| `fund <persona> <amount>` | treasury (mnemonic base account) → persona account, `transferKeepAlive`. The only runtime path that reads `root`. |
| `status` | table: persona · address · balance, plus treasury balance |

## Security invariants

1. `mcp.js` never reads `fez-wallet/root` — enforced by construction
   (the root entry name appears only in `cli.ts`).
2. Key selection comes only from `FEZ_AGENT_PERSONA` env, never from
   tool arguments.
3. The allowance balance is the hard cap; thresholds only add prompts
   on top.
4. A consent approval counts only if it e-tags the request event AND is
   signed by the workspace owner npub.
5. The mnemonic is printed exactly once, at `init`, and never written
   to disk outside the keychain.

## Error handling

- Missing keychain entry → tool error naming the fix
  (`fez-wallet derive <persona>`).
- Chain unreachable → typed error, no retry loops inside a tool call.
- Insufficient balance → error stating balance vs. requested (the
  envelope speaking).
- Consent timeout/decline → distinct results so agents can react
  differently.

## Testing

- **Derivation vectors:** fixed test mnemonic → expected SS58 addresses
  per persona (and expected EVM addresses for the stub's paths).
- **Consent state machine:** mocked relay — approve, deny, timeout,
  wrong-signer reaction (must not execute), reaction on wrong event.
- **Adapter:** substrate adapter against a mocked `@polkadot/api`;
  `NotEnabledError` from evm.
- **Manual e2e:** full ceremony + agent send on Bittensor **testnet**
  (config endpoint override) before real TAO touches it.

## Out of scope (v1)

Desktop wallet pane; EVM/USDC live support; hotkey/miner registration
(bazaar work); zap/lightning integration; spend analytics.
