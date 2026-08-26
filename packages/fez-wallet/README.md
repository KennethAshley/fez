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
0.01 TAO, `thresholds` in `~/.fez/wallet.json`) post a consent request
(kind 47103) to `consentChannel` and wait up to 10 minutes for the
owner's ✅ / ❌ reaction. Timeout declines.

## Custody invariants

1. The MCP server never reads the root mnemonic (only `cli-commands.ts`
   may; `grep -rn '"root"' src | grep -v cli-commands` stays empty).
2. Key selection only from `FEZ_AGENT_PERSONA` env.
3. The allowance balance is the hard cap; thresholds only add prompts.
4. A consent approval counts only when it e-tags the request AND is
   signed by the workspace owner.
5. The mnemonic is printed once, at init, and lives nowhere but the
   keychain.

## Testnet e2e (before real TAO)

1. Point the endpoint at testnet: set `endpoints.tao` to
   `wss://test.finney.opentensor.ai:443` in `~/.fez/wallet.json`.
2. `fez-wallet init`, fund the treasury address from the testnet faucet.
3. `fez-wallet derive <persona>` for an agent that runs in your fleet,
   `fez-wallet fund <persona> 0.1`.
4. From the agent: `wallet_balance`, then a sub-threshold `wallet_send`
   back to the treasury address (auto), then an over-threshold send —
   approve the ✅ path once and let one time out.
5. `fez-wallet status` and `wallet_history` should agree with the chain.

## GUI

The extension ships a gui part: consent requests in chat grow
Approve ✅ / Decline ❌ buttons (they publish your ordinary reaction —
the same event the wallet trusts), and Settings gains a Wallet card
with live balances and the spend ledger. The panel reads only the
public state the CLI mirrors into extension storage (addresses,
endpoint, history) — keys never touch the webview. Ceremony (init/
derive/fund) remains CLI-only by design.
