# Mining as an Agent Capability — Design

**Date:** 2026-09-08
**Status:** Draft for review
**Supersedes the UI model of:** `2026-09-08-mining-in-chat-design.md` (the `#mining`
channel + per-miner thread stay; the "system posts a root line signed by the owner,
nav-view is the cockpit" model is replaced).

## The problem

The mining UI feels bolted on. Three concrete symptoms, one root cause:

1. **`#mining` and the ⛏ nav view are two unrelated surfaces**, tied only by a link.
2. **Management is duplicated** — the nav view (`MiningPage`) and the thread card
   (`MinerCard`) each reimplement start/stop/config/logs/metagraph against the
   `fez-mine` CLI, independently.
3. **The thread root `⛏ mining · netuid 56 · persona drift` is plain text signed by
   the owner** — not by the persona. "drift" is a label, not a speaker.

**Root cause:** mining's "persona" is only a *wallet identity* (a hotkey). The miner
runner (`fez-mine-run`) has zero chat/Nostr awareness. Meanwhile Fez already has a
complete *agent* system — a persona running as a chat agent, signing as itself,
answering @mentions and DMs with a real LLM loop, with generic MCP tool attachment.
Mining never connected to it. "quill the miner" and "quill the chat agent" are two
systems sharing a name.

## The reframe

**A miner is an agent doing a job.** Mining is not a standalone extension with its own
channel; it is a *capability a persona has*. quill is a chat agent that happens to
mine. You talk to it about mining in `#mining` — or any channel — because the
conversation loop and tool plumbing already exist. The work is **connecting mining to
the agent**, not building agent-chat.

Everything below rides infrastructure that is already built and confirmed:
- A running `fez agent <persona>` signs every message with its own stable
  `agent:<name>` keychain key (`packages/fez-acp/src/service-common.ts:11`, via
  `@fezchat/protocol` `getKey`). Persona-authored messages already work.
- The conversational loop — subscribe, detect @mention, gate by author policy, run a
  Claude Code / pi turn, reply as itself — is complete and generic
  (`packages/fez-acp/src/agent.ts`).
- Personas attach MCP tools by declaring `mcpServers: [...]` in frontmatter, resolved
  through `~/.fez/settings.json`'s `mcpServers` catalog (`src/extensions/mcp-servers.ts`,
  `agent.ts:230-243`). Precedent MCP-shipping extensions: `fez-wallet`, `fez-kanban`,
  `fez-polls` (all via `fez.parts.skill`).
- `getKey('agent:<name>')` is a plain OS-keychain shell-out any co-resident Node
  process can call; `fez-kanban`, `fez-polls`, `fez-communities`, `fez-sentinel`
  already sign as a persona this way, bypassing `ctx.channels`.

## Architecture

Three sub-projects, built in order. Each is independently shippable and testable. They
share one model — **the persona is the subject; mining is the verb** — so this is one
design doc, but writing-plans should produce a staged plan (one stage per sub-project).

```
┌── Sub-project 1: Mining MCP tool ───────────────────────────────┐
│  fez-mining ships an MCP server (parts.skill). A persona that    │
│  declares `mcpServers: [mining]` can, mid-conversation, call     │
│  mining_status / mining_metagraph / mining_list / mining_start / │
│  mining_stop — scoped to its OWN persona via FEZ_AGENT_PERSONA.  │
│  → @quill "how's mining?" in any channel → quill answers.        │
│    (reachable + conversational, entirely on existing infra)      │
└─────────────────────────────────────────────────────────────────┘
┌── Sub-project 2: Proactive status as the persona ───────────────┐
│  The headless reconcile signs lifecycle posts with              │
│  getKey('agent:<persona>') instead of ctx.channels.say (owner). │
│  started / registered / stopped / pod-evicted / reprovisioned /  │
│  earned become quill TALKING in #mining, unprompted.            │
└─────────────────────────────────────────────────────────────────┘
┌── Sub-project 3: One agents-native management surface ──────────┐
│  Collapse the duplicated MiningPage + MinerCard into a single    │
│  owner. Mining agents surface in the existing roster with a ⛏    │
│  badge; per-miner management lives in one thread card; the       │
│  start-a-miner flow also wires the persona for chat (roster to   │
│  #mining, add the mining skill to its frontmatter).             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Sub-project 1 — Mining MCP tool

**Goal:** a running agent can inspect and manage *its own* miner, and therefore answer
questions about it in any channel or DM.

**Components**
- **New `packages/fez-mining/src/mcp.ts`** → built to `dist/mcp.js`. A stdio
  `@modelcontextprotocol/sdk` `McpServer`, following `packages/fez-wallet/src/mcp.ts`
  and `packages/fez-polls/src/mcp.ts` exactly (same SDK, same launch shape).
- **Manifest:** add `fez.parts.skill` to `packages/fez-mining/package.json`:
  `"skill": { "command": "node", "args": ["dist/mcp.js"] }`. `fez link`/`fez install`
  merges this into `~/.fez/settings.json`'s `mcpServers.mining`
  (`src/cli/cmd-extensions.ts:347-367`).
- **Build:** add the `src/mcp.ts` esbuild target to the package's build script
  (mirrors how `gui`/`headless`/`cli` are built today).

**Tools** (each a thin wrapper over an existing `fez-mine … --json` verb — the CLI
already emits JSON for all of these, `packages/fez-mining/src/cli.ts`):

| Tool | Wraps | Scope | Gating |
|------|-------|-------|--------|
| `mining_status` | `fez-mine status --persona <P> --json` | read | none |
| `mining_metagraph` | `fez-mine metagraph --netuid N --persona <P> --json` | read | none |
| `mining_list` | `fez-mine subnets` / active-miner list | read | none |
| `mining_start` | `fez-mine start --persona <P> --netuid N [--machine local\|lium]` | mutate | risk policy (below) |
| `mining_stop` | `fez-mine stop --persona <P> --netuid N` | mutate | risk policy |

**Conversational control is the point.** "quill, mine 56 on lium" → quill calls
`mining_start(netuid: 56, machine: "lium")` → the runner provisions and starts. The
agent passes only non-secret parameters (netuid, machine); any required secret (the
Lium API key) resolves from the keychain at launch and never enters the chat turn.
Money-spending starts (renting a real pod) fire the harness approval gate first;
reads are ungated. This is the headline capability — the tools are what make a running
agent a miner you can *direct*, not just query.

**Persona scoping:** the MCP server reads `FEZ_AGENT_PERSONA` (set by the harness for
every attached server, `agent.ts:317-338`) and defaults every tool's `--persona` to it,
so quill's tools act on quill's miner. An explicit `persona` arg is rejected if it
differs from `FEZ_AGENT_PERSONA` (a persona manages only its own miner).

**Opt-in:** a persona gains these tools by having `mcpServers: [mining]` in its
frontmatter. Sub-project 3's start-a-miner flow writes that line; until then it can be
added by hand.

**Data flow:** `@quill how's mining?` → SummonEngine mention path (already built) →
quill's session invokes `mining_status` → CLI → JSON → quill phrases a reply, signed
as `agent:quill`. No new chat code.

**Testing:** unit-test each tool's argument→CLI-invocation mapping and JSON
passthrough with a stubbed CLI runner (the CLI verbs themselves are already tested).
One test that an explicit foreign `persona` arg is refused.

**Out of scope:** `mining_config` (secret-bearing) as a tool — config stays in the GUI
(secrets never transit an LLM turn). See "Security".

---

## Sub-project 2 — Proactive status as the persona

**Goal:** lifecycle events are quill talking, unprompted, not owner-signed system text.

**Components**
- **`packages/fez-mining` depends on `@fezchat/protocol`** (precedent:
  `fez-communities`, `fez-kanban`, `fez-polls`, `fez-sentinel` all import `getKey`
  from it).
- **`packages/fez-mining/src/persona-post.ts` (new):** a small helper
  `postAsPersona(persona, channelId, text, opts?)` that resolves
  `getKey('agent:'+persona)`, builds a `KIND_CHANNEL_MESSAGE` event (`h` tag =
  channelId, optional `e` thread-root tag), `finalizeEvent`s with the persona key, and
  publishes to the relay. This is the pattern `fez-polls/src/mcp.ts:22` and
  `fez-kanban/src/mcp.ts:30` already use, extracted to one tested unit.
- **`packages/fez-mining/src/headless.ts`:** the reconcile's lifecycle replies and the
  thread-root backfill switch from `ctx.channels.say(...)` (owner-signed) to
  `postAsPersona(miner.persona, …)`. The root line and each lifecycle reply are now
  authored by the miner's persona.

**Design decision — sign directly, no new host seam.** The extension-api's sanctioned
surface (`ChannelsAccess.say`) always signs as the owner and has no "post as persona"
parameter — that is the one real gap. Two options:

- **(A) Sign directly with the persona key** (chosen). Matches four existing sibling
  extensions; no host change; works even when quill isn't running as a chat agent.
- **(B) Add a `ChannelsAccess.sayAs(persona, …)` host seam** so the extension-api
  permission model keeps governing the post.

We choose **A**: it is the established repo pattern, keeps this within the mining
package, and (A)'s independence from the LLM agent is a feature — proactive status must
fire whether or not quill's conversational process happens to be up. (B) is the
"cleaner governance" path and is noted as a future refactor if the host ever
centralizes persona-signing; **YAGNI** until then.

**Precondition (verify, don't build):** for a persona-signed post's `@mention` of
another agent to be honored, and for the summoner to treat the persona as authorized,
the persona's `agent:<name>` key must carry an owner-published attestation
(`KIND_AGENT_ATTESTATION` / 47006, `agent.ts:791-798`). For an owner's own personas
this should already hold (it is what lets them act as the owner's agents). The plan's
first step verifies this live for quill; if absent, rostering via the existing
`personas.invite`/attestation path is the fix — still not new infrastructure.

**Data flow:** reconcile detects a transition (existing `lifecycleMessage`, pure,
already tested) → `postAsPersona(persona, #mining, text, {threadRoot})` → appears as
quill in the miner's thread.

**Testing:** `postAsPersona` unit-tested with stubbed `getKey`/`finalizeEvent`/publish
— asserts the event is signed by the persona key and carries the right `h`/`e` tags.
`lifecycleMessage` already covers the text.

---

## Sub-project 3 — One agents-native management surface

**Goal:** kill the duplicate management UI; make mining visible where agents already
live; make "start a miner" also wire the persona for chat.

**Components**
- **De-duplicate:** management logic (status/logs/config/start/stop/metagraph) gets
  ONE owner. The per-miner **thread card (`MinerCard`, `registerThreadView`)** keeps
  full management (it is the accessible seam that renders in-timeline and matches "manage
  in the thread"). The **nav view (`MiningPage`)** becomes a thin **index**: the list of
  miners + the "start a miner" flow only — its embedded per-miner config editor is
  removed. No logic is implemented twice.
- **Agents-native visibility:** a persona that is mining shows a **⛏ badge + netuid** in
  the existing roster/cast (`App.tsx:1240-1259`), so the miner list *is* the agent list.
  (Reads mining state; no new sidebar-section host seam — see "Deliberately out of
  scope".)
- **Start-a-miner flow (the connective tissue):** starting a miner for persona P now
  also (a) ensures P is rostered to `#mining` so `@P` mentions there are answered
  (existing `personas.invite`), and (b) adds `mining` to P's frontmatter `mcpServers:`
  so P can answer mining questions (sub-project 1). Both are idempotent and reversible.

**Design decision — no extension-owned sidebar section.** There is no
`GuiExtensionApi` seam for an extension to own a labeled sidebar tree; `registerNavView`
only yields one row in the shared "extensions" group. Building a true "Mining" section
would need a new host seam. We **do not** build it: the agents-native win comes from the
⛏ badge on the *existing* roster, not a new section. A dedicated section is a possible
future host change, explicitly out of scope here.

**Testing:** the de-dup is mostly deletion; the start-flow's two side effects
(roster + frontmatter write) get unit tests with a stubbed persona store, asserting
idempotency and that a stop/removal cleanly reverts the frontmatter opt-in.

---

## Security & trust boundaries

- **Secrets never enter an LLM turn.** `mining_config` set/unset is *not* an MCP tool;
  config with secret fields stays in the GUI, secrets stay in the keychain (service
  `fez-mining`). Read tools expose only public data (status, metagraph, ss58 hotkey).
- **`mining_start`/`mining_stop` are mutations gated by the harness risk policy**
  (`harness.ts:528-568`) like any tool; they act only on the calling persona's own
  miner (`FEZ_AGENT_PERSONA` scoping, foreign-persona arg refused).
- **Signing as the persona** uses the user's own persona key, on the user's own
  machine, published only to the user's own relay — the same trust boundary four
  sibling extensions already operate within. Nothing leaves for an external service.
- **Testnet guard unchanged:** registration still runs through fez-wallet's
  `requireRehearsalNetwork`; the MCP `mining_start` inherits it.

## Deliberately out of scope

- A new host seam for an extension-owned sidebar section (agents-native visibility uses
  the existing roster badge instead).
- A `ChannelsAccess.sayAs` host seam (sub-project 2 option B).
- **Conversational config/secret entry.** Directing a miner by talking (start/stop/query)
  is in scope via the gated tools. What stays GUI-only is *editing config and entering
  secrets* — a secret must never transit an LLM turn, so "set my lium key to …" is not a
  tool; you set it once in the cockpit and thereafter direct the miner conversationally.
- Mainnet mining (still gated on the Task-11 unlock, unrelated to this work).

## Build order & rationale

1. **MCP tool** — highest-leverage wow (quill answers in chat), pure wiring over built
   infra, unblocks the conversational half immediately.
2. **Proactive persona status** — makes quill talk unprompted; depends only on the
   persona-key helper, independent of the LLM agent running.
3. **Management consolidation** — de-dupes the UI and adds the start-flow wiring that
   makes 1 turnkey (auto-declares the mining skill on the mining persona).
