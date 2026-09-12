# Workspace owner pinning implementation plan

> Execute the approved first implementation slice with test-first changes and a scoped security review. Preserve the checkout's existing, unrelated changes.

**Goal:** Remember the trusted workspace owner across sessions, and refuse silent authority changes advertised by relay infrastructure.

**Approved design:** Owner pinning is the first slice of durable jobs, followed by durable acceptance delivery and scoped job grants. This patch implements owner pinning; the other two slices retain their separate runtime and delivery requirements.

**Architecture:** Keep owner validation and relay identity normalization in TypeScript shared by all callers. Persist pins through the existing client persistence seam and a Node store for headless processes. An explicit expected owner supplied by the user or invite outranks discovery; existing installations use trust on first use, then reject mismatches. Missing relay metadata must preserve an existing pin. The agent owner and workspace owner remain separate identities.

**Constraints:** No dependencies, no identity secrets in the webview, no blanket roster admission, no automatic key rotation, no changes to unrelated work. Trust persistence errors must fail closed. New behavior is covered in `packages/fez-evals`; root typecheck and the full eval gate are required.

1. [x] Add failing checks for persisted owner protection, metadata outage, malformed keys, and explicit expected-owner mismatch.
2. [x] Implement shared owner resolution, durable pins, and client bootstrap/join integration.
3. [x] Route headless runtime and tool authority lookups through the same pin semantics; prove a restart cannot adopt a foreign roster.
4. [x] Update current trust documentation, run build/typecheck/evals, and review the scoped diff.

**Acceptance checks:** An attacker changing NIP-11 cannot gain roster authority after a pin exists. The original owner's signed roster remains authoritative. A fresh invitation can state its expected owner before discovery. Restart and HTTP outage cannot erase a pin. Legacy unpinned installs pin their first valid discovered key; key rotation requires an explicit future operation.

**Verified:** `npm run build` passed for core and 49 packages; root `npx tsc --noEmit` and desktop `cargo check` passed. The full `npm run evals` gate passed with 2,308 tests (8 skipped). The onboarding-community and workspace-management Playwright files passed all 15 checks. Independent scoped review approved the implementation after configured-owner precedence and native invite-persistence ordering were corrected. Git adoption tests now isolate their trust storage so repeated runs cannot retain a previous generated owner.
