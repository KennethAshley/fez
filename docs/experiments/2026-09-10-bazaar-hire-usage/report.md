# Repository hire cost accounting

The previous unattended LeBron hire completed successfully, but Bazaar recorded
$0 while Pi reported $0.0481656. This change repairs the reporting path and
adds reservations and cancellation to the worker's daily spending guard.

## Behavior

- The pinned Pi 0.84.2 / pi-acp 0.0.33 pair reads native session statistics
  before each prompt and after message, compaction, and settlement events.
  Subtracting the prompt baseline includes cached-token, tool, and compaction
  costs without charging previous prompts again.
- The adapter advertises `fezUsage: 1` during ACP initialization and emits
  per-prompt totals under `session/update._meta.fezUsage`. Fez forwards these
  through `HarnessUpdate`; budgeted hires require an explicit metering
  handshake before the model call. Custom harnesses must also declare that
  they perform this handshake. Unsupported engines are refused.
- `fez-agent --hire-protocol` returns `FEZ_HIRE_PROTOCOL=1` without starting a
  worker. Bazaar probes this before passing a task to an installed runtime.
  `FEZ_HIRE_MAX_COST_USD` carries the remaining allowance. `FEZ_HIRE_STARTED`
  marks the point where model work may start, and `FEZ_HIRE_USAGE` carries
  cumulative USD and token totals plus a final-total marker.
- Bazaar persists each usage delta even when the model, timeout, or Git
  delivery fails. It uses the actual engine's reported cost, rather than
  pricing repository tokens with the miner's advertised text model. The
  builtin editor also reports its known cost before Git delivery.
- One task runs at a time per miner. A repository hire reserves the remaining
  daily allowance before dispatch. A definitive final total releases the
  unused reservation, and a failure before model work settles at zero.
  Unknown usage keeps a pending marker and the reservation across restart and UTC midnight, blocking
  further work until the operator reconciles the ledger. State writes are
  atomic; corrupt or unreadable existing ledgers are refused.
- Reaching the reported allowance aborts the harness and stops the worker's
  process group. Paid repository attempts are not automatically retried.

## Limits and rollout

Provider usage arrives after a request: an already in-flight request can exceed
the allowance. These are engine-reported cost estimates, not provider invoices.
This does not impose a shared cap across independent miners or wallet transfers.

The Fez bundle changes to `0.84.2+svc18`; the patched Pi adapter always rebuilds
with Fez. Bazaar and the worker's Fez bundle must both be updated. Other engines
need the same metering contract before budgeted hires are enabled for them.
No binaries were installed on the Air and no new paid hire was launched during
this implementation. The existing pilot ledger is unchanged.

## Verification

- Bazaar: 312 tests passed; typecheck and all builds passed. Tests cover actual
  Git delivery failures, signed relay results, duplicate totals, cap crossing,
  competing hires, restart/UTC reservations, malformed usage, old runtimes,
  unpaid validation failures, and process-group cancellation.
- Fez: 1,541 evals passed, 3 skipped; core plus 45 packages built; root and ACP
  typechecks passed. Focused metering and native-adapter tests passed.
- Compiled the patched, pinned pi-acp and fez-agent binaries. Exercised the
  real ACP connection and registered Pi harness with a local fake Pi RPC
  process: two prompts retained separate costs, compaction was included,
  final totals preceded completion, and crossing the allowance cancelled work.
  No provider requests were made.
- Independent code review found two issues, both fixed: the current Pi
  compaction event name, and releasing reservations after provably unpaid
  failures.

Bazaar implementation commits: `1c73882`, `513c861` on `codex/hire-usage`.
