# Fez Architecture

The maintained architecture documentation lives on the docs site:
**[docs.fez.chat/architecture](https://docs.fez.chat/architecture)**
(source: `web-docs/content/docs/architecture.mdx`). It covers the four claims the
design rests on, the component map with diagrams, and the message→answer
trace.

The short version:

- **Surfaces** — the TUI (`src/cli/tui.ts` + `packages/fez-tui`), the CLI
  (`src/cli/`), and the desktop app (`packages/fez-desktop`, Tauri 2 +
  React, with native signing and keychain access in Rust; onboarding and
  backup still handle keys in the shared webview).
- **One brain** — `packages/fez-client` holds all derived state and trust
  rules; every surface renders over it.
- **Protocol core** — `src/` (`@fezchat/protocol`): the kinds registry
  (`src/protocol/kinds.ts`), multi-relay connection, DM crypto, identity and
  keychain custody, harness/ACP driving, the extension host.
- **The relay is the workspace** — `packages/fez-relay`: NIP-01/11/42/50,
  ingest + delivery policies, JSONL/SQLite/BYO stores. Clients pin the owner
  from a trusted invite or first valid NIP-11 discovery. Later metadata
  must match that key before governed events are loaded.
- **Agents** — `packages/fez-acp` is the standing runtime, with harnesses
  via ACP (claude-code or the bundled pi) and `fez-orchestrator` (`@fez`).
  The desktop owns local agent processes and a background extension worker:
  closing the window keeps them running; confirmed Quit stops local work.
  `fez-sentinel` remains an optional host for headless machines.
- **Features are packages** — everything else in `packages/` ships as
  installable extensions against `packages/fez-extension-api`.
- **Evaluated work** — the sibling `fez-bazaar` uses ACP's generic evaluation
  seam with the actual persona, model and enabled tools. Its first coordination
  workflow is brief → script → speech, independently checked before quality
  counts. [The public guide](../web-docs/content/docs/concepts/bazaar.mdx)
  distinguishes operator-issued testnet jobs, authorized spending, specialist
  services, owner custody, SALT and stake. Coordination emissions are not active.

Workspace invites now carry `fez-join:<relay>#owner=<64-hex-pubkey>`.
Legacy relay-only invites use trust on first use. Node processes can supply
the independently trusted key as `FEZ_WORKSPACE_OWNER`. Desktop and Node
share immutable pins in `~/.fez/workspace-owners/`; the client also remembers
pins in its workspace list. Missing metadata retains a pin. Conflicting
keys or unreadable trust storage stop authority resolution rather than
resetting trust. Forgetting a workspace hides it without erasing its pin.
Automatic owner-key rotation and moving job history between relay addresses
are separate follow-up work; neither is implied by changing an endpoint.

An earlier version of this file described the pre-relay, pre-desktop,
single-relay SDK and aged badly — including a claim that no Rust layer
exists (desktop key custody is Rust) and that the self-hosted relay wasn't
built (it's deployed at `wss://relay.fez.chat`). If a statement here ever
disagrees with the site docs or the code, the code wins; update both.
