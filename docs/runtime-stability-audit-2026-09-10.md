# Runtime stability audit — September 10, 2026

Scope: the core SDK/harness and summon engine, `fez-acp` (including the bundled `fez-agent` entrypoint), legacy herdr, desktop summoning, GUI extension loading, and extension API boundaries. This was a targeted runtime and trust review, not an exhaustive security certification.

## Confirmed issues addressed

| Area | Failure | Change |
| --- | --- | --- |
| Agent identity | A relay participant could claim a registered persona's name and receive owner-signed trust or a roster invite. | Summoners resolve the local persona key before trusting announcements or waking an agent from a DM. Desktop uses the existing public-key-only native bridge. |
| Roster writes | A foreign roster could be copied into a new owner-signed roster. Failed reads could wipe membership in herdr. | Only the owner's roster is eligible; missing state rejects the write. Pending invites survive failures. |
| Concurrent invites | Two invitations in one summoner could overwrite each other's members. | Serialize each summoner's read/modify/publish sequence; a failed write does not poison later invitations. |
| Roster ordering | An equal-timestamp conflict could select an obsolete roster and restore removed members. | Both summoners and the client share the canonical lowest-event-ID tie rule. |
| Workspace admission | ACP accepted rosters from any signer and ignored bans. Rejected messages could still enter prompt context. | Reuse `WorkspaceState` for owner, roster, and ban rules. Exclude nonmembers before collecting context. Workspace authority comes from NIP-11, separately from the agent owner. |
| Relay recovery | Failed initial authority discovery would leave an otherwise connected agent blocked. | Retry discovery without guessing an owner; reload membership and bans before enabling requests. |
| Mentions | Quoted examples, code, and email-like text could activate running agents while the summoner ignored them. | One prose-mention parser feeds both paths; notification parsing retains its existing behavior. |
| Conversations | Separate threads shared model sessions, prompt history, queues, and steering. | A consistent conversation scope controls all four. Thread continuations retain their own session. |
| Document work | Queued, retried, or steered document requests lost their comment context and could reply in the channel. | Carry the document context through every redispatch path. |
| Cancellation | Pending steering could restart an owner-cancelled turn. | Clear steering for the cancelled conversation. |
| Queue admission | Removing a waiting member could stall later requests or leave revoked work inside a batch. | Recheck every queued member and continue draining after an admission rejection. |
| Context retention | Thread-based history would grow with every new conversation. | Keep at most 100 recent conversations with ten messages each; queued requests retain their original trigger after eviction. |
| GUI extensions | Async activation reported success early, errors escaped, and overlapping loads mixed registrations. Failed or removed extensions could leave handlers behind. | Await and serialize activation; restore registry snapshots on failure/reload, including artifact viewers and overwritten entries. |
| Harness startup | A missing/non-executable ACP adapter emitted an unhandled child-process error and could terminate its host. | Both harness paths await process startup and reject the request on failure. |
| SDK identity | Auto-generated private keys were printed to logs. | Log only the public key. |

Regression checks exercise signed local relay traffic and the actual ACP runtime with a controlled harness, the real GUI extension loader in JSDOM, and real missing-process failures in isolated subprocesses. They use temporary identities and homes, with no model calls or production relay writes.

## Remaining work, in priority order

1. **Make extension consent accurately describe authority.** Headless `gatedClient` gates selected crypto methods, but higher-level client mutations still pass through. The GUI hands the whole client to extensions with `read:channels`. These are trusted-code extensions, and current grants are not a security sandbox. A narrowed client API and migration of existing extensions need a separate compatibility pass.
2. **Coordinate roster writes across processes.** The new invitation queues protect one summoner instance. Desktop, sentinel, and other writers can still race against each other. A shared writer or reconciliation strategy must cover all writers rather than adding more local locks.
3. **Finish or deprecate the legacy task SDK contract.** The `Agent` class's 47001 task path still only logs cancellation requests; callback failures and repeat `start()` calls also deserve dedicated lifecycle coverage. The standing ACP runtime is a different path and handles owner cancellation.
4. **Bound harness initialization.** Prompt deadlines already exist, but a process that starts successfully and never answers ACP initialization can still leave session opening unresolved. This needs a handshake timeout with process cleanup and a real silent-adapter regression.

Keep larger cleanup tied to these behaviors. Splitting the large ACP file or adding another extension abstraction by itself would not resolve them.

## Verification

- Built core and all 44 packages; rebuilt desktop after integrating main's 0.4.31 question UI and rebuilt ACP after the final queue fixes.
- Full eval gate: **1,511 passed, one skipped** across 161 files.
- Desktop browser checks: **six passed**, covering Browser install/setup/reload, welcome research, welcome kickoff, question forms, and questions in channel/DM threads.
- Root, ACP, desktop, client, and herdr typechecks passed. Full lint passed with six existing warnings and no errors.
- Compiled the agent bundle as **0.84.2+svc15** so a subsequent desktop release cannot reuse the old runtime.

New regression files live in `packages/fez-evals/tests` (`acp-admission`, `acp-conversations`, `recent-context`, `harness-spawn`, `agent-identity-logging`, `desktop-summoner`, `herdr-summoner`, and `gui-extension-lifecycle`).
