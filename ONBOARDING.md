# Onboarding audit — fez-desktop

Findings from a fresh-user-machine audit of `packages/fez-desktop` (2026-08-24).
Ordered by where a new user hits each one. Check items off as they're fixed.

## Tier 1 — blocks onboarding outright

- [ ] **Sign + notarize the app.** Built `.app` is ad-hoc signed, no `_CodeSignature`, not notarized
  (`src-tauri/tauri.conf.json` has no `bundle.macOS` block). Downloaded quarantined copy →
  "fez-desktop is damaged and can't be opened" (unrecoverable variant). Covers the parked
  notarize / xattr-docs / brew-cask work. Rename `com.ken.fez-desktop` → product identifier
  FIRST (see Tier 3) — changing it later resets keychain ACLs + TCC for existing users.
- [ ] **Intel Macs: bundled agent silently broken.** `pi` / `pi-acp` are thin arm64
  (`src-tauri/pi-agent/`, no universal build). `harness_installed` (`src-tauri/src/lib.rs:355`)
  checks file existence only → UI claims agent installed, every spawn fails. Either ship
  universal binaries or detect arch and tell the user.
- [ ] **Quarantine survives the copy.** `std::fs::copy` in `install_bundled_agent` preserves
  `com.apple.quarantine` → Gatekeeper kills `~/.fez/bin/pi` on downloaded builds. Strip xattrs
  (or re-sign) after copy (`src-tauri/src/lib.rs:1112`).
- [x] **One canonical relay default.** DONE: `src/relay.ts` is now the single home of
  `DEFAULT_RELAY` (hosted relay) + `relaySet()`/`relayRaw()`; all four former literal sites
  (`App.tsx`, `Onboarding.tsx`, `SettingsPane.tsx`, `ManagePane.tsx`) import it. The localhost
  fallback is gone — devs use `VITE_FEZ_RELAY=ws://localhost:7777`. Still open (split out):
  - [ ] A real "can't reach relay" state (splash dismisses regardless; offline looks empty-but-working).
  - [ ] Default relay is a single DO droplet by IP — needs a stable domain.
- [x] **Keychain failure is a dead end.** DONE: `get_identity` now distinguishes
  errSecItemNotFound (exit 44 / "could not be found" → "no fez identity…" → onboarding) from
  access failures (denied prompt, locked keychain → "keychain access failed…"), so a denied
  prompt no longer routes into onboarding where `set_identity` would refuse anyway. The boot
  error screen is a `BootError` component with an unconditional "try again" button (boot
  un-caches failed promises) and an Always-Allow hint on keychain errors. The `fez keygen`
  CLI mention is gone.

## Tier 2 — silent brickers and inverted onboarding

- [x] **Failed agent copy bricks forever.** DONE: copies extracted into a fallible
  `copy_agent_files` (pi, pi-acp + chmod, theme, wasm all required); the version marker is
  stamped only after every copy succeeded, so a transient failure retries next launch. An
  unreadable `VERSION` now stamps/compares as `""` instead of forcing a ~140MB re-copy
  every launch.
- [ ] **First launch blocks on ~140MB copy.** Copy runs synchronously in `.setup()` before the
  window appears — app looks hung. Move async / show progress.
- [ ] **Onboarding UI is inverted.** `FirstRun.tsx` panel only renders when `members.size > 1`
  (`App.tsx:1731`) — impossible for a fresh solo user, who instead always gets "agents can't
  hear you here… /invite members from the TUI" (`App.tsx:1726`). Un-gate FirstRun for solo;
  drop TUI references from desktop copy.
- [ ] **Non-owner with zero channels can't join or claim anything.** `+` (ManagePane) gated on
  `isOwner` (`App.tsx:846-855`); ManagePane is the only home of JoinByCode + CreateCommunity.
  Rail says "unclaimed — claim it to start" while hiding every control that could claim it.
- [ ] **Relay notices are thrown away.** `App.tsx:381-385` wires `"notice"` to a force-render
  that drops the payload — the client's "claim this workspace" / "ask the owner for an invite;
  your key: …" messages (the only first-run explanations) are never shown.
- [ ] **@fez never answers, nothing says why.** Desktop never starts the agent runner (launchd
  sentinel is CLI-installed); the exact message FirstRun suggests gets no reply, no timeout,
  no error. Detect the runner's absence locally and surface it.
- [ ] **Extension install can panic.** `install_package` settings closure uses `.unwrap()` on
  `as_object_mut()` (`lib.rs:576-596`) — panics on unexpected `settings.json` shape
  (`remove_extension` at `lib.rs:779-789` is defensive; match it).
- [ ] **settings.json truncation risk.** `serde_json::to_string_pretty(...).unwrap_or_default()`
  then write (`lib.rs:269`, same at `lib.rs:401`) — a serialize failure writes an empty file,
  wiping all skills/grants/MCP servers.
- [ ] **`wire_chutes_pi` clobbers pi config.** Malformed/object-shaped `local-models.json` parses
  to empty vec, then overwritten (`lib.rs:392-401`) — destroys user's other local model
  endpoints. Also writes the Chutes API key to disk in plaintext right after reading it from
  the keychain (`lib.rs:397`).
- [ ] **No error boundary.** `main.tsx` has no ErrorBoundary / onerror / onunhandledrejection —
  any render throw = white window.

## Tier 3 — trust and polish

- [ ] **Rename bundle identifier** `com.ken.fez-desktop` → `com.fezchat.*` (or product domain)
  before any public build (`tauri.conf.json:5`; also `Cargo.toml` scaffold
  `description = "A Tauri App"`, `authors = ["you"]`).
- [ ] **Replace scaffold branding:** stock Tauri icons (`src-tauri/icons/*`),
  `<title>Tauri + React + Typescript</title>` + vite.svg favicon (`index.html:5-7`),
  product/window name `fez-desktop` → real product name.
- [ ] **Find-and-replace damage in visible copy:** "new client.state.workspace",
  "client.state.workspace name", etc. (`ManagePane.tsx:77,197,345-346`).
- [ ] **CSP + raw key exposure.** `"csp": null` (`tauri.conf.json:21-23`) while `get_identity`
  returns the 64-hex private key over the invoke bridge (`lib.rs:7-31`) and the webview evals
  third-party GUI extension bundles (`gui-extensions.ts:594-602`). Set a real CSP; consider
  keeping the key out of the webview entirely (sign in Rust).
- [ ] **Undisclosed default endpoints.** Skill installs POST a signed (pubkey-bearing) receipt to
  `fez-web-kohl.vercel.app/api/counts` with no consent/toggle (`SkillsView.tsx:35-36,307,757`);
  drag-drop uploads go to `blossom.primal.net` in the clear with no disclosure at the drop
  point (`upload.ts:16`, `App.tsx:1620-1631,1941-1954`).
- [ ] **No updater.** No tauri-plugin-updater, no endpoints, no pubkey — early users stranded on
  0.1.0 permanently. Retro-fitting later can't reach already-installed copies.
- [ ] **Minimum OS is a lie.** `Info.plist` claims 10.13; main binary needs 11.0; bundled `pi`
  needs macOS 13 (`LC_BUILD_VERSION minos 13.0`). Set `minimumSystemVersion` honestly.
- [ ] **Release build can silently ship agent-less.** `prepare-pi-agent.mjs:62-73` exits 0 when
  bun is missing (writes `VERSION = "none"`); `PI_REF` defaults to unpinned clone
  (`prepare-pi-agent.mjs:32`); `pi-agent/` is gitignored so fresh clones reproduce the empty
  case. Make release builds fail loudly; pin PI_REF; add a real release CI job.

## Papercuts

- [ ] Draft cleared before unguarded `await` — pre-wire send failure eats the typed message
  (`App.tsx:1568-1599`; same shape in DM send `App.tsx:1932-1938` and JoinByCode
  `ManagePane.tsx:212-232`).
- [ ] Desktop copy points at TUI/CLI: `FindSource.tsx:203-205` ("fez skill add …"),
  `RemindersPane.tsx:90` ("/remind from the TUI"), `App.tsx:1728` ("/invite … from the TUI").
- [ ] `ModelPicker.tsx:31-34` swallows the useful "Set the Chutes key first" error from Rust.
- [ ] Harness detection misses `~/.bun/bin`, volta, asdf, fnm, pnpm-global, custom NVM_DIR
  (`lib.rs:341-348`); existence-only check reports quarantined/wrong-arch binaries as installed.
- [ ] Agent create form allows harness=pi with no provider/model; success screen promises a spawn
  that will never happen (`AgentsPane.tsx:690-736,743-753`). `harnesses.ts:31-32` defaults
  unknown harnesses to "installed".
- [ ] Offline first launch looks like an empty-but-working app: NIP-11 failure renders an owned
  workspace as "unclaimed" (`App.tsx:824,859`), `wire.ts` queries resolve `[]` after 5s, splash
  dismisses regardless; reconnect loop never backs off (`wire.ts:83-89,124`).
- [ ] `write_skill`/`remove_skill` miss `create_dir_all` — fail on machines where `~/.fez` doesn't
  exist yet (`lib.rs:1041-1075`).
- [ ] MCP skill install writes `npx …` commands verbatim with no node/npx check; failure happens
  later in a process the app doesn't own (`SkillsView.tsx:782-812`).
- [ ] `ureq` calls have no read timeout; offline installs hang a command thread
  (`lib.rs:404,460,481,661,688`). Tarball fetch: no size cap, no shasum/integrity check
  (`lib.rs:471-489`).
- [ ] `ModelPicker.tsx:14` duplicates the hash-derived Chutes provider id from `lib.rs:378` with
  no shared source.
- [ ] Stale theme files never cleaned up on agent upgrade (the re-copy-every-launch half of
  this is fixed with the version-marker fix).
