# Shared Models GUI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent components. Steps use checkbox syntax. Preserve the existing checkout and unrelated edits; this builds on the uncommitted, installed Mini pilot. No commits, release, or publication are required.

**Goal:** Select the configured Mini's model for an existing Fez agent, manage the provider from extension settings, and verify a normal signed conversation.

**Architecture:** The mesh extension owns native service controls, owner-authorized caller enrollment, and its settings card. Desktop gains a generic extension model-provider registry. ACP honors an explicit per-agent model profile; each profile has a separate bearer credential, mapped by the signing gateway to that agent's own key. Startup never grants membership.

**Tech Stack:** Existing TypeScript, React, extension process bridge, pi, Fez relay, NIP-98 and launchd. No new runtime dependencies.

**Spec:** User-approved conversation design, made concrete in the constraints and contracts below.

## Global Constraints

- Use the already-configured Mini. Keep Bazaar unchanged. No machine pairing wizard or automatic discovery.
- Settings must show Ready/Offline and Start/Stop; errors are visible. Agent selection must preserve identity, prompt, tools and other frontmatter.
- Every caller uses its own key. No private keys or bearer credentials enter the GUI. The host checks fresh membership, including revocation. No cloud fallback or automatic model retries.
- Tools run on this Mac; inference runs on the Mini. UI must say so. Models remain visible when offline and unknown saved selections are preserved.
- Follow existing UI styles and package/permission rules. Tests live in fez-evals. Run root/changed-package checks, full evals, live Mini task, and browser/native UI verification.

## Contracts

```ts
interface ExtensionModelProvider {
  id: string; // ext-<installed extension name>-<provider>, e.g. ext-mesh-mini
  label: string;
  listModels(): Promise<Array<{ id: string; label: string; status: "ready" | "offline" | "busy"; detail?: string }>>;
  prepare(persona: string, model: string): Promise<void>;
}
// GUI selection adds modelProfile: provider.id. Preparing happens on Save,
// before writing the persona, never just by viewing or selecting an option.
// ACP validates and loads ~/.fez/model-profiles/<provider>/<persona>/.
// It must contain models.json and settings.json pinning the selected model,
// retry.enabled=false, plus profile.json binding {provider,model,persona}.
// Missing/mismatched profiles fail closed; existing non-profile agents keep working.
```

Mesh CLI `state --json` returns only public state:
`{configured,provider,model,label,machine,status,detail?,callersVerified,callers:[{persona,pubkey}]}`.
`connect --name <persona>` explicitly enrolls the identity and prepares its profile.
`disconnect --name <persona>` revokes it. Existing start/stop/status/ask remain usable.

### Task 1: Generic desktop provider selection

Files: desktop model provider registry, ModelPicker, PersonaEditor, AgentsPane,
gui-extensions, extension-api GUI types; new model-provider GUI tests.

- [x] Write failing behavioral tests: contributed model is selectable; prepare failure prevents persona save; unknown/offline selection remains visible; extension reload removes contributions; switching to a built-in clears modelProfile.
- [x] Implement `registerModelProvider`, with source ownership, input validation and registry rollback, plus `prepareAgentModel(selection,persona)` that rejects missing extension providers.
- [x] Wire both persona save paths and persist modelProfile without disturbing unrelated fields. Use the existing GUI-change event for registry refresh.
- [x] Run focused GUI tests and desktop/API checks. Review scoped diff.

### Task 2: Per-agent Mini enrollment and signing

Files: mesh config/CLI/transport and enrollment module; mesh provider tests.

- [x] Write failing live-loopback tests with two keys: each completion has its own signer; unknown tokens fail; revoking one leaves the other usable; reconnect does not re-admit anyone.
- [x] Implement owner-only `connect` and `disconnect`; generate private per-agent tokens and profiles. Store token hashes in a private caller registry, validate its identity bindings, and preserve the legacy pilot token.
- [x] Gateway resolves caller identity from bearer token on every request. Return no secret material from state/connect/disconnect commands.
- [x] Implement public state reporting using existing complete readiness checks. Run focused tests and mesh typecheck. Review scoped diff.

### Task 3: Runtime profile, extension card, installation and acceptance

Files: ACP model-profile module and startup, mesh gui/build/package/README, runtime/GUI tests.

- [x] Write failing tests for profile mismatch/missing profile and isolated pi defaults; implement profile activation before harness detection/evaluation. Keep credentials out of logs and GUI.
- [x] Build a Shared Models settings card using existing extension settings/process APIs. Register the Mini provider; prepare invokes connect only on explicit Save. Include grant explanation, retry/error feedback, Start/Stop/Refresh and per-agent Revoke access.
- [ ] Build, link extension with its required grants, and install updated development GUI/runtime without overwriting unrelated settings or identities.
- [ ] Verify the actual card and picker, an existing persona's private model profile, two distinct caller identities, revocation, offline failure and a real signed thread reply through the Mini. Restore any temporary test configuration.
- [x] Run full evals, root and changed-package checks, and scoped review. Record results and exact user-facing entry point.

## Progress

- Planning: contracts agree across all three tasks. Desktop prepares identity profiles; mesh writes them; ACP validates the same binding. No shared mutation files between delegated desktop and mesh tasks.

- September 18 implementation: desktop registry, creation/editor saves, settings display label, mesh GUI/process bridge, per-agent credential/signing profiles, fresh roster access list (including the original pilot), and ACP mandatory model selection are implemented. The runtime confirms the exact provider/model through ACP before sending a prompt; saved defaults alone are insufficient because pi can fall back after invalid model configuration.
- Focused GUI checks: 33 passed. Root, desktop, extension API, ACP and mesh typechecks passed. Desktop production build and mesh CLI/GUI/evaluation bundle build passed. Initial full gate: 2,599 passed / 12 skipped; final review-fix gate: 2,615 passed / 12 skipped (305 files passed, 6 skipped).
- Read-only live status: kenmini.local Ready, callersVerified true, original mini-mesh key present. No caller grants or revocations were made by the GUI work.
- Installation blocked at the approval boundary: automatic review rejected `npx tsx src/cli/index.ts link packages/fez-mesh --no-build` because it persistently grants ui/processes permissions. A pending user question explicitly requests local extension + runtime installation approval. Do not work around the rejection. No link/install was executed.
- Remaining acceptance after approval: link extension, install freshly compiled local agent runtime, restart only the local gateway to load per-agent resolution, open an updated native development app, select the model for an existing persona, verify a signed test conversation against the Mini plus revoke/offline handling, and preserve/restore unrelated configuration.
- Native dev app compiled and launched via `npm run tauri -- dev`, then task-owned dev processes were stopped while installation waited. CUA cannot select the bare dev executable; use a uniquely named .app development bundle for native visual verification. Installed /Applications/Fez.app remains unchanged.

- Packaging: incremented the bundled runtime marker to `0.84.2+svc30` so desktop builds cannot reuse an old agent that ignores modelProfile. `npm run prepare-pi-agent` rebuilt the staged pi-acp/agent/relay/background/MCP binaries successfully. This modified repository build artifacts only, not installed binaries or grants. The staged app resources are ready for an approved development install.

- Final verification: full evals exited 0 with 2,615 passed / 12 skipped; log `/private/tmp/fez-shared-models-evals-final.log`. A later tooltip-only change passed its 18 focused GUI tests, and desktop production build passed again. Root/core emit, ACP build/check, extension API check, mesh build/check, and bundled runtime assembly all passed. Scoped review's two findings (cloud fallback, hidden pilot) are fixed.
- The rejected command had a mistaken source entry path; after explicit installation approval, the actual source command is `npx tsx src/cli.ts link packages/fez-mesh --no-build` (or `node dist/cli.js link packages/fez-mesh --no-build`). This is the same blocked installation action, not a workaround; approval is still required.
