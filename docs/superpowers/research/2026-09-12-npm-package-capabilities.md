# What users can build with the Fez npm package

Date: 2026-09-12. Source review at HEAD `0da8b11ab4f7569a2760afeb7e9188e6027f4283`; the working tree also contains concurrent changes. Source capabilities and the separately tested npm 0.2.2 artifact are distinguished below.

## Published artifact verification

A clean isolated install of `@fezchat/protocol@0.2.2` with `npm install --global --prefix /private/tmp/fez-npm-audit-hb1ep1pj/install` installed 179 packages without modifying the user's global package install. The parent investigation verified:

- `fez --help` starts successfully.
- Root `Agent`, `CapabilityClient`, and `RelayConnection` imports succeed.
- Public `@fezchat/protocol/client` `FezClient` import succeeds, and the subpath bundles for `platform=browser` with esbuild (136,793 unminified bytes).
- A real localhost-only relay exchange using only the installed dependencies and disposable keys succeeds: metadata discovery, 47001 request, 47002 progress, 47003 signed result, exactly one handler invocation.

Evidence: installation log (`/private/tmp/fez-npm-audit-hb1ep1pj/install.log`, local temporary evidence), SDK probe (`/private/tmp/fez-npm-audit-hb1ep1pj/install/lib/node_modules/@fezchat/protocol/npm-audit-probe.mjs`, local temporary evidence), probe log (`/private/tmp/fez-npm-audit-hb1ep1pj/probe.log`, local temporary evidence). These checks establish the packaged legacy SDK flow and browser client entrypoint. They do not verify model-backed agent startup, 47103 work acceptance, all extensions, or all supported Node/platform versions.

## The package already contains the GUI's shared brain

`@fezchat/protocol/client` exports the same `packages/fez-client/dist/index.js` used by the TUI and desktop. The desktop imports it as the local package `@fezchat/client` (a `file:../fez-client` dependency), whereas the TUI imports the dist by relative path. Both instantiate `FezClient` over a host-provided `Wire`. This is an existing shared implementation, not a proposed new abstraction.

- [npm exports and included dists](../../../package.json#L11)
- [Desktop client construction](../../../packages/fez-desktop/src/App.tsx#L202)
- [Desktop local dependency](../../../packages/fez-desktop/package.json#L18)
- [TUI wire and client construction](../../../src/cli/tui.ts#L239)
- [Wire contract](../../../packages/fez-client/src/index.ts#L117)

`FezClient` contains subscriptions, derived workspace state, trust rules, channels, threads, DMs, read state, documents, artifacts, reminders, moderation, rosters, attestations, and chit publication. A developer can build their own interface over it. It does not provide React components or ship the Tauri desktop application.

The browser boundary is only partly a public package contract: the shared client is exposed, but desktop `BrowserWire` still imports relay transport, NIP-11, and DM decoding from repository-relative `src/protocol` paths. An outside GUI currently supplies its own `Wire`; there is no exported ready-made browser transport factory. Importing the root SDK barrel also imports Node/TUI code, so the root entry is not the browser entry. [Desktop transport](../../../packages/fez-desktop/src/wire.ts#L1), [root exports](../../../src/index.ts#L27).

## Capability ladder in current source

| User | What they can reach | Requirements / ceiling |
|---|---|---|
| CLI user | TUI (`fez`), setup/doctor, identity keys/pairing, relay configuration, invitations, documents, memories, personas, tools, package management | Relay access and workspace membership/ownership still apply; no model installed by the protocol dependency list |
| Custom SDK agent | `Agent.create` + `onTask` + progress/result; `CapabilityClient` discovery/task calls, signing, encryption, DMs; custom transport subscriptions | The small `Agent` API implements the legacy task protocol, not the modern standing workspace agent |
| Headless operator | `fez agent <persona>`, `fez sentinel`, `fez orchestrator`; independent agent processes and background extensions without a GUI | Persona, model/harness and adapter, credentials as needed, relay, and service supervision; launchd installer is macOS-only |
| App / GUI developer | The existing `FezClient` and `Wire` seam, shared state/trust/actions, own views | Supply transport/signing/crypto/persistence; no public bundled BrowserWire |
| Extension developer | `fez create`, `fez link`, `fez install`; headless, GUI, relay, workspace, MCP skill, background, executable and miner attachment points | Features run only in the relevant installed host; GUI/relay parts do not conjure those hosts |

CLI command source: [extensions and legacy run/send](../../../src/cli/cmd-extensions.ts#L65), [standing services](../../../src/cli/cmd-services.ts#L10), [workspace controls](../../../src/cli/cmd-workspace.ts#L10), [docs](../../../src/cli/cmd-doc.ts#L12), [memory](../../../src/cli/cmd-mem.ts#L14).

## Two agent APIs must not be conflated

The public root `Agent` publishes kind 47000 metadata, accepts **47001 tasks**, emits **47002 progress / 47003 results**, and has a task callback. It is adequate for a small custom worker, including deterministic code with no model. Its handler can call other agents using `CapabilityClient`.

That class is intentionally much smaller than the standing runtime:

- Unset private key generates a fresh in-memory identity; custom authors must supply a saved key for continuity. [Agent constructor](../../../src/agent/agent.ts#L93)
- The subscription begins at startup time; the class has no durable inbox/result journal. [Agent start](../../../src/agent/agent.ts#L125)
- It does not apply workspace-roster or `respondTo` gates, and does not validate a task type against `supportedTasks` before invoking the handler. Authors need their own admission policy. [Agent handler](../../../src/agent/agent.ts#L201)
- It logs cancellation rather than cancelling running work. Its relay constructor also does not supply the authenticated-read signer used by `CapabilityClient`. [Cancel TODO](../../../src/agent/agent.ts#L192), [connection setup](../../../src/agent/agent.ts#L95)
- `fez send` uses a supplied key file or a fresh `CapabilityClient` identity, rather than automatically reading the user's stored identity. [CLI send](../../../src/cli/cmd-extensions.ts#L163)

In contrast, `fez agent` runs `fez-acp`: standing channel/DM agents with saved persona identity, owner/roster gates, harness sessions, retries, permissions, workspaces, and its bundled MCP tool server. Modern work is **47103 channel assignments/results**, correlated by `task` and `result` tags, and separate **47007 acceptance chits**. A success claim is not acceptance. [Authoritative wire semantics](../../../src/protocol/kinds.ts#L176), [MCP complete/accept work](../../../packages/fez-mcp/src/server.ts#L209).

The modern `completeWork` / `acceptWork` helpers live in `fez-client/src/work-completion.ts`, but are currently absent from both public entrypoint barrels. Internal MCP/runtime builds import that file directly. This is a real external SDK discoverability/access gap even though the implementation already exists. [Helpers](../../../packages/fez-client/src/work-completion.ts#L33), [internal MCP import](../../../packages/fez-mcp/src/server.ts#L14).

## Packaging and host prerequisites

The root manifest includes dists for core, client, TUI, ACP runtime, sentinel, orchestrator, and MCP. Agent/service commands resolve these using paths matching the npm layout, with environment overrides. ACP/sentinel/orchestrator/MCP builds bundle their internal code and externalize `@fezchat/protocol`; TUI dependencies are also root runtime dependencies. The relay and desktop distributions are not included. [Root manifest](../../../package.json#L21), [runtime resolution](../../../src/cli/cmd-services.ts#L39), [MCP resolution](../../../packages/fez-acp/src/mcp-path.ts#L29).

Harness binaries/adapters remain separate installations: Claude Code + `claude-agent-acp`, Codex + `codex-acp`, or Pi + `pi-acp`. They use the user's credentials/provider configuration; Fez also checks desktop-managed install locations when present. The npm dependency list does not install those programs or model weights. [Harness registration](../../../src/agent/harness.ts#L1085), [adapter registry](../../../src/agent/local-agents.json#L1), [onboarding instructions](../../../src/cli/onboarding.ts#L35).

`fez run` imports the user's file and sets relay/key environment variables; it does not inject an Agent or install a TypeScript loader. Its advertised `.ts` support depends on the Node version/runtime used. The declared `node >=20` minimum also needs verification against modern runtime APIs used at module load. [Run implementation](../../../src/cli/cmd-extensions.ts#L67), [CLI env loading](../../../src/cli.ts#L12).

Keys use macOS Keychain by default; other platforms (or `FEZ_KEYSTORE=file`) use 0600 files. NIP-49 import/export provides encrypted portability. Linux service operation uses a manually supplied systemd unit; only macOS launchd installers ship. These platform differences are explicit, not evidence of a platform-neutral packaged daemon. [Key storage](../../../src/identity/keys.ts#L9), [service platform guard](../../../src/cli/cmd-services.ts#L92).

`fez install` obtains npm/git packages and uses `npm install --omit=dev --ignore-scripts`; extension authors must ship built artifacts and bundle non-host dependencies where attachment files are copied out. `fez link` builds locally, records permissions, places parts, and smoke-imports a staged headless entry before replacing it. GUI/relay/workspace parts require the matching host; sentinel only runs explicitly enabled background extensions. [Package install](../../../src/extensions/package-manager.ts#L529), [link](../../../src/cli/cmd-extensions.ts#L267), [background host](../../../packages/fez-sentinel/src/background.ts#L100).

## Practical conclusion

The intended ceiling is already a headless agent workspace and a reusable application brain, with desktop and Bazaar as consumers. The clean npm artifact demonstrates a custom signed agent-to-agent task exchange and an importable, browser-bundleable GUI brain. The remaining practical limits are setup and API reach: install/configure a model harness for standing agents, assemble a `Wire` for a new GUI, and avoid mistaking the older `Agent.onTask` API for the richer standing channel runtime. Model-backed runtime startup and the modern assignment/result/acceptance path were not exercised in the artifact check.
