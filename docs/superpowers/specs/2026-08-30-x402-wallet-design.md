# x402 in the wallet — design

**Decision (2026-08-30, supersedes the core-seam draft):** x402/USDC payments live in the **fez-wallet extension**, under the wallet's existing **allowance-account security model**. There is no new core payment rail and no separate `@fezchat/x402` extension. Paid services (Ridges first) are extensions/tools that call the wallet, exactly as agents already call `send`.

## Why here

- **The wallet was built for this.** `chains/evm.ts` is a deliberate stub whose own comment says: "The stub exists so the adapter registry and agent-facing tools are final today — enabling ETH/USDC will not change any tool signature."
- **The allowance model already answers custody.** The master mnemonic stays in the keychain (CLI-only); each agent holds only a derived per-agent key. A compromised agent process can drain at most its own funded allowance — bounded loss, the same model fez shipped for TAO. This replaces the core-custody argument: no trusted-signer-serving-untrusted-callers boundary exists, so no Rust signer is needed.
- **It serves headless autonomy.** Agents (miners, bazaar workers) pay on their own without the owner's desktop being online; big spends still require the owner's ✅.
- **All policy machinery already exists here:** ✅-reaction consent (`consent.ts`), thresholds/caps (`config.ts`), 47040 receipts (`receipt.ts`), the spend log (`log.ts`). One money system, one audit surface.

Explicitly out of scope (tracked elsewhere): gating `signEvent`/`get_identity` (audit finding — separate security pass); human-initiated payments from the desktop gui (keys aren't in the webview; later); migrating TAO custody host-side (later coherence pass, maybe never).

## x402 v2 mechanics (grounded against /coinbase/x402, 2026-08-30)

The **exact / EVM scheme** (USDC-on-Base):

1. Server answers **HTTP 402** with a `PAYMENT-REQUIRED` header = Base64 `PaymentRequired` JSON. `accepts[]` offers: `{ scheme: "exact", network: "eip155:<chainId>", amount: "<atomic units>", asset: "<token contract>", payTo, maxTimeoutSeconds, extra: { name, version } }`. Base Sepolia = `eip155:84532`, Base mainnet = `eip155:8453`.
2. Client signs **EIP-712** typed data — an EIP-3009 `TransferWithAuthorization { from, to, value, validAfter, validBefore, nonce(bytes32) }`, domain `{ name: extra.name, version: extra.version, chainId, verifyingContract: asset }`. **No transaction is broadcast; no gas or RPC is required to pay** — the facilitator settles.
3. Client retries with a `PAYMENT-SIGNATURE` header carrying `{ signature, authorization }` (SDK-encoded).
4. The success response carries the settlement (on-chain tx hash) in a response header (SDK-decoded).

**SDK:** Coinbase's `@x402/core` (client + http header helpers) and `@x402/evm` (`ExactEvmScheme(signer)`, signer = a viem account). We use the SDK for all wire encoding — never hand-roll headers. (If the published packages differ from the docs at install time, verify exports first; hand-roll only the exact scheme, against this section, as a last resort.)

## The design

### Derivation — the money tree grows an EVM branch

Same mnemonic, standard recoverable path: BIP39 seed → BIP32 `m/44'/60'/0'/0/<index>` → secp256k1 key → EVM address. `<index>` is a per-persona integer persisted in wallet config (`evmIndexes`), assigned on first derive. Recovery = mnemonic + small index scan in any standard wallet. `fez-wallet derive <persona>` derives and stores the EVM pair beside the sr25519 pair; the address is printed for funding.

### The tool — `x402_fetch`

An agent-facing wallet tool beside `send`: `x402_fetch({ url, method?, body?, maxUsd })` (`maxUsd` required). Flow:

1. Fetch. Non-402 → return the response (body bounded).
2. On 402: decode offers; **pick only** `scheme === "exact"` ∧ `network === configured eip155 id` ∧ `asset === pinned USDC contract` (case-insensitive). No matching offer → refuse with the offers listed. **Never accept another asset** — USD math (`value / 1e6`) is only honest for 6-decimal USDC.
3. **Policy, in order:** `usd ≤ maxUsd` (caller ceiling) → `todaySpend + usd ≤ dailyCapUsd` → balance check (best-effort `balanceOf` via RPC; on RPC failure proceed — the check exists to spare a pointless consent round, settlement fails safely if unfunded) → if `usd > autoApproveUnderUsd`: owner consent via the existing 47103 + ✅ kind-7 flow (10-min timeout; the request text names amount, payTo, and url; sign **the held offer**, never a re-fetched one).
4. **Record before retry:** append the spend to the tally and the log (`status: "signed"`) *before* sending the paid retry. Every signature counts against the cap at issuance — an authorization is money in flight.
5. Retry with the `PAYMENT-SIGNATURE` header. Success → parse settlement tx hash, mark the log entry settled, publish a **47040 receipt** (existing `buildReceipt`; chain `"base"`, the configured network, the EVM tx hash, memo = url). **A second 402 after payment, or an ambiguous network failure after the paid request was sent, is surfaced ("may have settled — do not retry; check receipts") and never auto-repaid** — mirroring `ambiguousTransferError`'s discipline.
6. Return the response (body bounded) plus a one-line spend summary.

### The restricted signer

Even though the agent's own process holds its derived key, the signer handed to the x402 SDK is wrapped: it signs **only** typed data whose `primaryType === "TransferWithAuthorization"` and whose `domain.verifyingContract` equals the pinned USDC contract for the configured network. This keeps a malicious 402 *server* from steering the client into signing anything else (e.g. an EIP-2612 `Permit`).

### Config (`WalletConfig` grows)

```
x402: {
  network: "base-sepolia" (default) | "base",
  autoApproveUnderUsd: { default: 0, [persona]: n },   // 0 = always ask
  dailyCapUsd: 25,
  rpcUrl?: string                                       // default https://sepolia.base.org
}
evmIndexes: Record<persona, number>
```

Pinned USDC contracts: base-sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Base **mainnet** address ships commented-out with a "verify against Circle's official docs before enabling" note — mainnet is ~2 weeks out and the flip is config, not code.

Daily tally: `{ day, usd }` in an `x402-spend.json` beside the wallet data (the proven fez-acp `spend.json` pattern), owner-local day roll.

### evm.ts adapter

`address()` and `balance()` (USDC `balanceOf` via a viem public client) get filled. `transfer()` **stays** `NotEnabledError` — x402 is a payment scheme beside the adapter, not `adapter.transfer`; direct EVM transfers remain a later release.

## First consumer

`@fezchat/ridges` (separate build): `ridges_dispatch` calls `x402_fetch` against `POST https://product.ridges.ai/v1/issues`. Its output is a PR on GitHub, so the agent needs no response-relay machinery — dispatch + receipt suffices.

## Done when

- `fez-wallet derive <persona>` yields a funded-able EVM address recoverable at `m/44'/60'/0'/0/<index>` from the mnemonic (verified against the standard test vector).
- `x402_fetch` completes 402 → policy → consent → sign → retry → 47040 against an in-test x402 server, refusing wrong-asset/network/scheme offers, over-`maxUsd` and over-cap spends, and never signing anything but `TransferWithAuthorization` for the pinned contract.
- The double-pay invariant is test-enforced: the tally/log records before the paid retry; a post-payment 402 or ambiguous failure surfaces without re-paying.
- Money code gets a final review on a **different model** than wrote it (the money-path rule).
