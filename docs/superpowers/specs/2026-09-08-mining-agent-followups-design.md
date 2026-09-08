# Mining Agent Follow-ups — Design

**Date:** 2026-09-08
**Status:** Draft for review
**Builds on:** `2026-09-08-mining-as-agent-capability-design.md` (the MCP tool + persona
posting + start-flow wiring, all shipped to main). This adds two focused capabilities on
top of that base.

## The two gaps

The shipped feature made quill a miner you can talk to and that talks in #mining. Two
things it does not yet do:

1. **quill never messages you first.** When a miner hits a state that needs a human —
   reprovision cap hit, process died, deregistered — that surfaces only in the #mining
   channel. quill should tap you on the shoulder in your DM.
2. **You cannot tune a miner by talking.** Config editing is GUI-only. Non-secret params
   (daily cap, model, refresh interval) are safe to set conversationally; only secrets
   must stay in the cockpit.

Both are small extensions of shipped code, and both grounded out with no new host support
needed.

## Sub-project D — Proactive DM attention pings

**Goal:** on a *transition into* a needs-attention state, quill sends the owner a DM,
signed as quill, once per transition.

**What triggers it — only "needs-attention", never routine lifecycle.** The reconcile's
`planRemote` already emits an `action: "needs-attention"` with an `attention` string when
a miner needs a human (past the daily reprovision cap, died, deregistered — see
`packages/fez-mining/src/reconcile.ts` / the `needs-attention` branch in
`headless.ts:66-70`). Routine events (started, stopped, earned) stay in #mining as they do
today; the DM is reserved for "quill needs *you*." This keeps DMs signal, not noise.

**Fire once per transition, not every tick.** The reconcile runs every 120s; a
needs-attention miner would otherwise DM on every tick. Track the last attention reason
DM'd per miner in `api.storage` (key `dm-attention:<minerKey>`), and send only when the
current `attention` differs from the stored value. Clear the stored marker when a miner
leaves the attention state (so a later recurrence pings again). This mirrors the existing
lifecycle-snapshot pattern (`lifecycle:<minerKey>` in `headless.ts`).

**Components:**
- **`packages/fez-mining/src/persona-post.ts`** — add `dmOwnerAsPersona(persona: string,
  ownerPubkey: string, text: string): Promise<string>`. Same custody shape as the shipped
  `postAsPersona`: resolve `getKey('agent:'+persona)`, build a `CapabilityClient({ relay:
  resolveRelays(), privateKey })` (from `@fezchat/protocol`, already a dependency), call
  `sendDm(ownerPubkey, text)`, and dispose the connection. Returns the DM event id. Throws
  if the persona has no local key (caller catches).
- **`packages/fez-mining/src/attention-dm.ts`** — a pure `attentionDmText(netuid, persona,
  reason): string` producing quill's message, so the wording is unit-testable without a
  relay. E.g. `⛏ heads up — your netuid ${netuid} miner needs you: ${reason}.`
- **`packages/fez-mining/src/headless.ts`** — in the `needs-attention` branch, after the
  state write, read `dm-attention:<key>`; if it differs from `m.attention`, call
  `dmOwnerAsPersona(m.persona, ctx.ownerPubkey, attentionDmText(...))` inside a try/catch
  (a DM failure logs and never aborts the tick), then store the new marker. Where a miner
  transitions OUT of attention (its plan action is no longer needs-attention on a fresh
  read), clear the marker.

**Data flow:** reconcile detects a needs-attention transition → `dmOwnerAsPersona(quill,
ctx.ownerPubkey, text)` → a gift-wrapped DM from quill lands in your DM with quill. You can
reply ("stop it") and quill — running as a chat agent with the mining tools — acts.

**Testing:** `attentionDmText` unit-tested (contains netuid + reason). The transition/dedup
logic gets a unit test if the branch is extracted to a pure helper
(`shouldDm(prevMarker, currentAttention): boolean`); otherwise it's covered by the existing
reconcile tests plus a targeted test of the marker compare. `dmOwnerAsPersona` is not
unit-tested beyond compile (it is I/O over the same primitives `postAsPersona` already
proved); the live smoke is the acceptance check.

## Sub-project E — Gated conversational config

**Goal:** a running agent can set NON-secret miner config by conversation; secrets stay
GUI-only and never transit an LLM turn.

**Components:**
- **`packages/fez-mining/src/mine-cli.ts`** — add two `mineArgs` builders:
  `describe(netuid) => ["describe", "--netuid", String(netuid), "--json"]` and
  `configSet(persona, netuid, key, value) => ["config", "set", "--netuid", String(netuid),
  "--persona", persona, "--key", key, "--value", value]` (note: NO `--secret` flag — this
  path never writes secrets). Both are pure, unit-tested like the existing builders.
- **`packages/fez-mining/src/mcp.ts`** — add the `mining_config` tool:
  `inputSchema: { netuid: z.number().int(), key: z.string(), value: z.string() }`.
  Behavior:
  1. `runMine(mineArgs.describe(netuid))` → parse `config: ConfigField[]`.
  2. Find the field whose `key` matches. If none → return "netuid N has no config field
     `<key>`" (list the settable non-secret keys). If `field.type === "secret"` → REFUSE:
     "`<key>` is a secret — set it in the mining cockpit, not chat." (Never call config set.)
  3. Otherwise `runMine(mineArgs.configSet(persona, netuid, key, value))` (persona =
     `FEZ_AGENT_PERSONA`, structural scoping as with every tool). On nonzero exit, return
     the error text.
  4. On success, return: "set `<key>` = `<value>` for netuid N. This applies on the next
     restart — say the word and I'll stop and restart the miner." (The tool does NOT
     restart.)

**Why the tool does not auto-restart.** `fez-mine config set` writes state/keychain only;
config is resolved at launch (`run.ts` `resolveConfig`), so a running miner keeps its
launch-time config until stop→start. Auto-restarting would silently tear down and
re-provision a Lium pod (real money). Instead the tool reports that a restart is needed;
the agent restarts via the existing `mining_stop` + `mining_start` tools **only if the
user confirms** — keeping the costly step a separate, approved action.

**Testing:** the two new `mineArgs` builders get arg-mapping unit tests. The secret-refusal
and unknown-key branches are the critical logic — extract the decision to a pure helper
`classifyConfigKey(schema: ConfigField[], key: string): "secret" | "unknown" | "ok"` and
unit-test all three outcomes (a secret field refused, an unknown key refused, a plain field
allowed). The tool wiring then calls that helper.

## Security & trust boundaries

- **No secret ever transits the LLM turn.** `mining_config` refuses `type: "secret"` fields
  *before* any config-set call; it reads the schema (types), never secret values (and
  `fez-mine config get` already masks secrets to `"set"`/`"unset"`). Secret entry stays the
  GUI's job.
- **The DM is persona→owner only.** `dmOwnerAsPersona` sends to `ctx.ownerPubkey` — the
  machine owner — signed by the persona's own key. It never DMs a third party, and the text
  is a status line, not sensitive data.
- **Restart stays gated.** A config change that needs a restart to apply routes through the
  existing gated `mining_start`/`mining_stop` tools on explicit user confirmation — no
  auto-churn of paid pods.
- **Persona scoping unchanged:** `mining_config` takes no persona arg; it acts on
  `FEZ_AGENT_PERSONA`'s own miner.

## Out of scope

- Two-way DM *threads* about mining beyond what the generic agent loop already gives (quill
  already answers DMs — this only adds it *initiating* one).
- Batching or a shared relay connection for the per-call DM/publish pattern (the shipped
  per-call connect+dispose is fine at the reconcile's 120s cadence).
- Conversational secret entry (permanently out — secrets are GUI/keychain only).
- The C3 roster ⛏ badge (still deferred; unrelated host change).

## Build order

1. **E (config tool)** first — pure additions to shipped files (`mine-cli.ts` builders +
   `mcp.ts` tool + a `classifyConfigKey` helper), no custody surface, fully unit-testable.
2. **D (DM pings)** second — adds the `dmOwnerAsPersona` custody helper and the reconcile
   wiring; its acceptance is a live smoke (a real DM from quill), so it lands after the
   cheaper, fully-testable piece.
