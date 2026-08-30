# @fezchat/wallet

Per-agent allowance wallets for fez. One master mnemonic (yours, in the
macOS keychain, service `fez-wallet`) hard-derives an sr25519 account
per agent at `//<persona>`. The balance on an agent's account IS its
spending cap. TAO is live; the adapter interface already carries the
EVM stub, so ETH/USDC arrive later without changing any agent-facing
tool.

## Ceremony

    fez-wallet init              # once; prints the 24 words exactly once
    fez-wallet derive scout      # per agent
    fez-wallet fund scout 0.5    # treasury → agent
    fez-wallet status            # who has what

## Agent tools (MCP skill part)

`wallet_address` · `wallet_balance` · `wallet_send` · `wallet_history`
— always scoped to the calling agent (identity from FEZ_AGENT_PERSONA,
never from arguments). Sends over the per-agent threshold (default
0.01 TAO) post a consent request (kind 47103) to `consentChannel` and
wait up to 10 minutes for the owner's ✅ / ❌ reaction. Timeout declines.
Only ✅ approves — NIP-25's generic `"+"` like does not, so acking the
card in a stock nostr client never moves money.
`thresholds` (and `network`) are preferences, not config — they live in
the extension's prefs, changed from the CLI (`fez-wallet network`) or
the Settings → Wallet panel, never by hand-editing `wallet.json`.
`wallet.json` still holds what the CLI ceremony owns: persona indexes,
`consentChannel`, an explicit endpoint override — and saving it strips
everything else, so a derived endpoint or a prefs threshold can never
turn into a wallet.json override the selector cannot move.

## Custody invariants

1. The MCP server never reads the root mnemonic (only `cli-commands.ts`
   may; `grep -rn '"root"' src | grep -v cli-commands` stays empty).
2. Key selection only from `FEZ_AGENT_PERSONA` env.
3. The allowance balance is the hard cap; thresholds only add prompts.
4. A consent approval counts only when it e-tags the request, is signed
   by the workspace owner, AND is ✅ — never the generic `"+"` like.
5. An address event counts only when the roster member signed it: the
   relay's `authors` filter is advisory, and `FEZ_RELAY` is a list.
6. The mnemonic is printed once, at init, and lives nowhere but the
   keychain.

## Networks

    fez-wallet network            # which chain am I on
    fez-wallet network test       # testnet — play money
    fez-wallet network finney     # mainnet — real TAO

Keys are the same on both chains; balances, history and the ledger are
not. An explicit `endpoints.tao` in `wallet.json` still wins, for a local
node or a fork — "explicit" meaning an endpoint no network maps to. One
that does is network-owned: dropped on write, and ignored on read in
favour of the active network's, so a `wallet.json` pinned before that
rule existed cannot outlive it.

## Paying another owner's agent (two machines)

1. Both sides: `fez-wallet network test`, then `init` / `derive` / `fund`.
2. Both agents run once so each publishes its address event.
3. From one agent: `wallet_send` to `@theirname`, naming the message it
   pays for. Approve the card.
4. The bolt appears under that message on BOTH screens.
5. `fez-wallet status` and `wallet_history` reconcile to the chain on
   both sides.

Failure paths worth walking once: an agent that has published no address,
a payee on the other network, and a card left to time out.

No real TAO until this passes end to end.

## Resolution

`wallet_send`'s `to` is tried in order, and never blocks:

1. **A local store entry** (`chip`) — an agent you hold keys for.
   Unchanged; proof of delivery is the chain.
2. **A roster name** (`@chip` or `chip`) — the workspace's kind-`47000`
   announces, deduped by pubkey with the newest announce winning, then
   resolved through that agent's own published address event (kind
   `30175`, one per chain + network, signed by the agent's own nostr
   key; the newest wins there too, so a rotated address is never paid).
   Two roster members sharing a name is an error, not a coin flip: the
   send fails and names both candidates by npub rather than picking. An
   agent that has published no address for the chain fails the same way,
   by name.
3. **Anything else** is passed through as a raw address, exactly as
   before — the chain is the only validator of address shape.

Before signing, a send is refused if the resolved payee's announced
network differs from yours (`you're on test, chip is on finney —
nothing was sent`). A raw address (tier 3) announces no network, so this
guard does not cover that path — it still sends, unguarded.

A first payment to a given roster payee always raises a consent card,
whatever the amount; approved once, that payee is remembered by pubkey
(never by name — a name is not an identity) and the threshold governs
from then on.

## Receipts

`wallet_send` takes one more optional argument, `for` — the id of the
message the payment is for. Omit it and nothing changes: a plain
transfer, no receipt. Give it, and once the transfer lands the wallet
publishes a receipt (kind `47040`) naming that message, the payee, the
amount and the block the transfer landed in — rendered under the paid
message on every participant's screen, e.g.
`⚡ 0.05 TAO · a1b2c3d4… · couldn't check this block`.

A receipt can in principle be checked against the chain: fetch the
named block, compare signer, destination and amount. A public endpoint
prunes old blocks, though, so a receipt whose block has aged out simply
cannot be checked — that is **unverifiable, not false**; only a receipt
whose block was fetched and did not match would be shown as a lie.

**Known limitation:** every receipt in the UI today reads "couldn't
check this block," regardless of whether it would in fact verify. The
check itself (`verifyReceipt` in `src/receipt.ts`) is implemented and
tested at the library level and returns `"verified"` / `"unverifiable"`
/ `"false"`, but the webview does not call it yet — wiring that in is
future work, not something a user sees happen today.

If the receipt fails to publish, the transfer still stands and the
ledger still records it — the tool's reply just says the note didn't go
out.

## x402 (pay-per-call HTTP)

Agents can also pay ordinary HTTP servers that speak
[x402](https://x402.org): `x402_fetch({ url, method?, body?, maxUsd })`
fetches a URL, and if — only if — the server answers `402 Payment
Required`, pays for it in USDC on Base and retries. `maxUsd` is required;
there is no default.

    fez-wallet derive scout    # adds an EVM account alongside the TAO one

Fund the printed EVM address with Base-**Sepolia** USDC (a faucet, or a
transfer from another testnet wallet) — that account is the spending cap
for x402, exactly the way the TAO balance is the cap for `wallet_send`.

Config lives in `wallet.json` under an `x402` key (never in prefs — see
the comment on `x402Settings()` in `src/config.ts` for why):

    "x402": {
      "network": "base-sepolia",
      "chainRef": "eip155:84532",
      "usdcAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "autoApproveUnderUsd": { "default": 0, "scout": 0.05 },
      "dailyCapUsd": 25,
      "rpcUrl": "https://sepolia.base.org"
    }

- `autoApproveUnderUsd` — per-persona, `default` is the floor. `0` (the
  default) means every payment asks the owner first, the same consent
  card `wallet_send` uses, over `consentChannel`, with the price, the
  payee address, and the URL spelled out.
- `dailyCapUsd` — a hard ceiling across all calls in one local day,
  checked before consent, tallied in a `x402-spend.json` file beside
  `wallet.json`.
- **Mainnet flip:** set `"network": "base"`, `"chainRef": "eip155:8453"`,
  and `"usdcAddress"` to `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  (Base mainnet USDC, verified against Circle's own contract-address
  docs on 2026-08-30) — a config change, not a code change.

**Never pays twice.** The moment a payment is signed and the price is
about to be retried, the daily tally and a `signed` row in the x402 log
(`x402-log.jsonl`, beside the tally file) are written *before* the paid
request goes out. If that retry throws, or answers `402` again, the tool
does **not** retry or sign a second time — it reports the situation as
ambiguous ("may have settled — check receipts and the spend log") and
leaves the spend recorded rather than risk paying twice. Only a genuine
2xx settlement gets logged `settled` and produces a kind-`47040` receipt,
same audit surface `wallet_send` uses (chain `"base"`, the tx hash, and
the URL as the memo).

## GUI

The extension ships a gui part: consent requests in chat grow
Approve ✅ / Decline ❌ buttons (they publish your ordinary reaction —
the same event the wallet trusts), and Settings gains a Wallet card
with live balances and the spend ledger. The panel reads only the
public state the CLI mirrors into extension storage (addresses,
endpoint, history) — keys never touch the webview. The same panel also
writes: a network selector (`test` / `finney`) and a consent-threshold
editor, both writing directly to prefs. Ceremony (init/derive/fund)
remains CLI-only by design.
