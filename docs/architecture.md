# Fez Architecture

The maintained architecture documentation lives on the docs site:
**[docs.fez.chat/docs/architecture](https://docs.fez.chat/docs/architecture)**
(source: `web/content/docs/architecture.mdx`). It covers the four claims the
design rests on, the component map with diagrams, and the message→answer
trace.

The short version:

- **Surfaces** — the TUI (`src/cli/tui.ts` + `packages/fez-tui`), the CLI
  (`src/cli/`), and the desktop app (`packages/fez-desktop`, Tauri 2 +
  React, with key custody in Rust).
- **One brain** — `packages/fez-client` holds all derived state and trust
  rules; every surface renders over it.
- **Protocol core** — `src/` (`@fezchat/protocol`): the kinds registry
  (`src/protocol/kinds.ts`), multi-relay connection, DM crypto, identity and
  keychain custody, harness/ACP driving, the extension host.
- **The relay is the workspace** — `packages/fez-relay`: NIP-01/11/42/50,
  ingest + delivery policies, JSONL/SQLite/BYO stores; its NIP-11 `pubkey`
  (`--owner`) names the only key whose channel/roster/ban events count.
- **Agents** — `packages/fez-acp` (the standing runtime), `fez-sentinel`
  (wake-on-mention), `fez-orchestrator` (`@fez`), harnesses via ACP
  (claude-code or the bundled pi).
- **Features are packages** — everything else in `packages/` ships as
  installable extensions against `packages/fez-extension-api`.

An earlier version of this file described the pre-relay, pre-desktop,
single-relay SDK and aged badly — including a claim that no Rust layer
exists (desktop key custody is Rust) and that the self-hosted relay wasn't
built (it's deployed at `wss://relay.fez.chat`). If a statement here ever
disagrees with the site docs or the code, the code wins; update both.
