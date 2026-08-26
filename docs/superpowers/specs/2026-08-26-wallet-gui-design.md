# Wallet GUI — consent inbox, balances, spend ledger

**Date:** 2026-08-26 · **Status:** draft for review · **Scope:** Ken's tiers 1–3 (inbox, balances, ledger-as-table); no top-up buttons (ceremony stays CLI)

## Shape

The GUI is the wallet extension's own `gui` part (`fez.parts.gui` →
`~/.fez/gui-extensions`) — install the extension, the surfaces appear;
uninstall, they vanish. No SettingsPane surgery, no desktop rebuild
coupling. Core contributes exactly one new generic seam (below); every
wallet-specific pixel lives in `packages/fez-wallet`.

Two surfaces, both existing GUI-API primitives:

1. **Consent inbox = a message decorator.** `registerMessageDecorator`
   matches wallet consent requests in chat and renders a card under the
   bubble: amount, recipient, memo, and **Approve ✅ / Decline ❌**
   buttons that publish the owner's reaction via the shared client —
   the exact event the wallet's `awaitDecision` already trusts. Once a
   matching owner reaction exists, the card shows the resolved state
   instead of buttons. No new trust surface: the GUI publishes as the
   user, which it can already do.
2. **Wallet panel = a settings panel.** `registerSettingsPanel("Wallet",…)`
   renders: treasury + per-agent **balances** (live chain reads over a
   browser `WebSocket` to the configured finney endpoint — addresses are
   public, no keys touch the webview), and the **spend ledger as a
   table** (time · agent · amount · to · memo · consent · tx), newest
   first, tx cell linking to taostats via `api.openUrl`.

## The one new core seam: gui `api.storage` (read-only)

GUI parts run sandboxed — no filesystem — so the panel cannot read
`wallet.json` or `wallet-log.jsonl`. Rather than a wallet-shaped hole,
core gains the symmetric half of a seam that already exists: headless
parts have extension-scoped `api.storage`; **gui parts get read access
to the same namespace** (`api.storage.get(key)`), backed by a Tauri
command that resolves ONLY within the calling extension's own storage
directory (name-validated, traversal-refused — same rigor as the
wallet's entry-name policy). Read-only in v1: the GUI renders state;
the CLI/MCP own writes.

The wallet then mirrors its public state into that namespace:

- `fez-wallet init`/`derive` write `addresses` (treasury + per-persona
  SS58 — public data) and the configured endpoint.
- `walletSend`/`fund` append the same `SpendEntry` they already log to
  the jsonl into a `log` key (bounded: last 500 entries).

Nothing secret ever enters storage: addresses, endpoints, and history
are exactly what the chain already shows.

## Consent-request matching

The decorator must not trust content cosmetics alone. Match =
(a) content matches the wallet request shape (`💸` header line +
`react ✅` footer, the format shipped in 7666088), AND (b) the author
pubkey is a known local agent (`client.pkByName` over announced
agents). The card degrades honestly: an unmatched or malformed message
just renders as a normal chat bubble.

Approve = `client.toggleReaction(channelId, msgId, "✅")` (decline ❌)
— the same reaction any client could send; the buttons are convenience,
not a second consent mechanism. The card reflects an existing owner
reaction (✅/❌) as "approved/declined", and shows "expired" when the
message is older than the 10-minute window with no reaction.

## Manifest & permissions

`packages/fez-wallet/package.json` gains
`parts.gui: "dist/gui.js"` (esbuild bundle, React injected by host —
`api.React.createElement`, no bundled React) and permissions gain
`read:channels` (client access for the decorator) and `ui`. Existing
`network:entrypoint-finney.opentensor.ai` already covers the balance
websocket; the panel reads the endpoint from storage, so a testnet
config renders testnet balances.

## Open implementation checks (resolve during build, not blockers)

- **Webview CSP**: confirm the desktop CSP's `connect-src` admits
  `wss://…finney…` from the webview; if not, extend the CSP (operator-
  controlled, one line in tauri.conf) rather than proxying.
- The gui loader's storage command must land in the loader/permission
  path (`list_gui_extensions`/`activate(api)`), typed in
  `packages/fez-extension-api/src/gui.ts` (mirror-sync note: the
  extension-api republish backlog).

## Out of scope

Top-up/fund from the GUI (treasury custody stays CLI-only — permanent
stance until revisited); write access to gui storage; a dedicated
left-rail pane primitive (settings panel is v1's home; a generic
`registerPane` seam is a separate conversation); EVM columns.
