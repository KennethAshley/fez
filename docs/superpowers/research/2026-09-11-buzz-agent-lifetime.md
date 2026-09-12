# Buzz agent lifetime: source audit

Read-only audit, 2026-09-11. No Buzz code, processes, or configuration changed; no runtime tests run.

Local `/Users/ken/Projects/buzz` is clean at `051c3a270be9c73da9ab06700bcab7d5552fceaa` (September 9). Public main was separately verified at `78618804ec86a014524ad7d1fb55928e8f5c3edf` (2026-09-11T20:38:41Z). The complete comparison, `/tmp/fez-buzz-lifetime-research/compare.json`, confirms the cited lifecycle policies are unchanged. Current-commit links below target unchanged files; changed files use the inspected old commit unless offsets were verified.

## Five implemented behaviors

1. **Desktop owns local processes.** Native AppState retains child handles keyed by `(agent pubkey, community relay)`; receipts record PID and desktop instance. Start/registration is serialized with shutdown. Existing live children are reused. There is no separate sentinel in this desktop lifecycle path. See [runtime_commands.rs:227–313](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src-tauri/src/managed_agents/runtime_commands.rs#L227-L313).

2. **Launch restores availability, and mentions can start stopped agents.** Restoration waits until identity, repositories, and workspace relay are ready. Local `start_on_app_launch` agents get lazy harnesses; reconciliation covers configured communities. A desktop mention publishes successfully before firing its queued start; a replay floor preserves the triggering message during startup. “Detached” in the frontend start helper means non-blocking operation, not an OS daemon. See [restore.rs:95–195](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src-tauri/src/managed_agents/restore.rs#L95-L195), [runtime_commands.rs:455–484](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src-tauri/src/managed_agents/runtime_commands.rs#L455-L484), [useMentionSendFlow.ts:584–592](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src/features/messages/ui/useMentionSendFlow.ts#L584-L592).

3. **Lazy listening and expensive work have different lifetimes.** A lazy harness maintains relay subscriptions before starting ACP workers. Accepted work wakes its pool; failed initialization retries only with pending work. Desktop lazy pools release workers after **15 minutes** of quiet, retaining the listener. Queued work and in-flight turns prevent sleep. See [pool_lifecycle.rs:1–127](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/crates/buzz-acp/src/pool_lifecycle.rs#L1-L127), [agent_env.rs:11–26](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src-tauri/src/managed_agents/agent_env.rs#L11-L26), [old lib.rs:3624–3676](https://github.com/block/buzz/blob/051c3a270be9c73da9ab06700bcab7d5552fceaa/crates/buzz-acp/src/lib.rs#L3624-L3676).

4. **macOS Close keeps work alive; actual Quit stops local work.** Main-window Close calls `prevent_close()` and `hide()`, retaining the app/webview. ExitRequested/Exit invokes shutdown: SIGTERM local process groups together, wait up to **2 seconds**, SIGKILL survivors, update records, sweep owned orphans. Remote backends are excluded. See [lib.rs:887–900](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src-tauri/src/lib.rs#L887-L900) (one-line offset verified), [shutdown.rs:128–298](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src-tauri/src/shutdown.rs#L128-L298).

5. **Remote lifetime is explicitly separate.** Desktop deploys through a provider; ordinary status and shutdown then use relay presence/messages. Quitting desktop does not stop remote agents. Kubernetes v1 defaults to **2 hours** inactivity and `restartPolicy: Never`; indefinite lifetime is refused in this version. Whole-harness inactivity exit defaults off in the generic ACP CLI. See [provider config.rs:33–62](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/crates/buzz-backend-kubernetes/src/config.rs#L33-L62), [148–164](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/crates/buzz-backend-kubernetes/src/config.rs#L148-L164), [ACP config.rs:503–518](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/crates/buzz-acp/src/config.rs#L503-L518).

## Caveats: implemented code, not promises

- **Not every launch is lazy.** Restore/pair APIs pass true, but legacy `start_managed_agent_process` passes false despite broader comments. See [old runtime.rs:877–914](https://github.com/block/buzz/blob/051c3a270be9c73da9ab06700bcab7d5552fceaa/desktop/src-tauri/src/managed_agents/runtime.rs#L877-L914); current patch changes session policy, not this branch.
- **Worker recovery is not harness supervision.** ACP refills crashed workers with backoff and a breaker: 3 crashes/60 seconds opens for 5 minutes ([old lib.rs:1908–2036](https://github.com/block/buzz/blob/051c3a270be9c73da9ab06700bcab7d5552fceaa/crates/buzz-acp/src/lib.rs#L1908-L2036)). Dead harnesses are recorded; no perpetual desktop harness-restart loop was found. Startup reconciliation retries at 5 seconds, 30 seconds, 2 minutes, then stops; successful relays are not revisited ([reconciliation policy](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src/features/agents/useManagedAgentRuntimeReconciliation.ts#L18-L44)).
- **Config restart is another policy.** It requires a running local process, config drift, connected observer, no work, opt-in, and 3 minutes of quiescence; one attempt per drift edge. It does not revive crashed processes ([autoRestartPolicy.ts](https://github.com/block/buzz/blob/78618804ec86a014524ad7d1fb55928e8f5c3edf/desktop/src/features/agents/lib/autoRestartPolicy.ts#L1-L105)).
- **Forced death differs from graceful Quit.** Unix signals have cleanup, and boot/periodic sweeps reap owned orphans; SIGKILL cannot run cleanup. The hide-on-close implementation is macOS-specific.

Useful distinction for Fez: native app ownership, visible window lifetime, lightweight relay listener lifetime, and expensive session lifetime are separate. Copy that boundary, not Buzz's entire runtime or remote infrastructure.

## Recommendation for this iteration of Fez

Use the native desktop app as the single owner of local agent and extension
processes. Keep the sentinel as an explicit TUI/server option. This is a design
recommendation, not a change made by this audit.

The running `com.fez.sentinel` launchd service was verified to invoke
`sentinel --extensions fez-github,slack`. That flag filters background extensions;
it does not disable agent summoning. The desktop yields all automatic wakeups
to a live sentinel PID in
[summoner.ts](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/summoner.ts:144).
This allows enabling an integration to change agent ownership implicitly.

The proposed user contract:

1. Opening Fez restores agents enabled for startup and the configured background
   integrations. The native backend owns one start/stop/restart/status path.
2. Closing the main window hides it and keeps Fez running, with a visible menu-bar
   control. Agents, Slack, and GitHub continue working while the machine is awake.
3. Explicit Quit stops local agents and integrations. Active work must be made
   visible before quitting; window-close remains the way to leave work running.
   Remote agents remain independent. This intentionally differs from Fez's
   current detached-process policy and must be communicated during migration.
4. Idle agents remain reachable while unused AI sessions are closed. Fez already
   implements a four-session cap and 30-minute idle reaping in
   [agent.ts](/Users/ken/Projects/Fez/fez/packages/fez-acp/src/agent.ts:1255).
   Whole-process `idleExit` is a separate optional policy; no replacement runtime
   or Buzz worker pool is needed to retain this distinction.
5. Tool/model edits display pending restart clearly; explicit Restart performs
   the restart. Preserve an active turn rather than silently killing it while
   reporting success. Currently
   [PersonaEditor.tsx](/Users/ken/Projects/Fez/fez/packages/fez-desktop/src/PersonaEditor.tsx:103)
   only calls kill while announcing a restart.

The first implementation slice should give the native app ownership of the
existing extension task host, reusing the TypeScript loader and permission
checks from
[sentinel index.ts](/Users/ken/Projects/Fez/fez/packages/fez-sentinel/src/index.ts:603).
Run that host as an app-managed background child without a second agent
summoner. Keep protocol logic in TypeScript and identity keys outside the
webview. Verify Slack/GitHub continuity before replacing the existing launchd
service. Then remove desktop PID-based sentinel deferral and consolidate the
remaining lifecycle callers. Do not disable the service first.

If surviving an explicit app Quit is a product requirement, choose one independent
background runtime with the GUI as its controller instead. That is a coherent
alternative, but requires an explicit control/status connection and removes
direct GUI spawning. It should not be implemented as two competing owners.
For the current desktop iteration, the app-owned approach reuses more of Fez's
existing structure and has fewer moving parts.
