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
- [x] **Quarantine survives the copy.** DONE: `copy_agent_files` stages each binary, strips
  `com.apple.quarantine` via `/usr/bin/xattr -d`, then atomically renames into place — which
  also means the sentinel can never spawn a half-copied executable and a running `pi` is
  swapped by directory entry, not written into.
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
- [x] **First launch blocks on ~140MB copy.** DONE: the copy runs on a spawned thread from
  `.setup()`; the window no longer waits on it (atomic renames make the mid-copy window safe).
- [x] **Onboarding UI is inverted.** DONE: FirstRun renders for every empty channel regardless
  of member count; the solo note only shows on channels with history, reworded without the
  TUI reference.
- [x] **Non-owner with zero channels can't join or claim anything.** DONE: the `+` manage
  button shows for everyone (ManagePane already gates owner-only levers internally and its
  no-channel branch is exactly JoinByCode + CreateCommunity); browse hint updated to match.
- [x] **Relay notices are thrown away.** DONE: `"notice"` now has a real handler — sticky,
  deduped toast (`toast.info(text, 0)`), so "claim this workspace" / "ask the owner for an
  invite; your key: …" actually reach the user.
- [x] **@fez never answers, nothing says why.** DONE (cold-start work): `runner_status` /
  `ensure_agent_runner` detect the sentinel pidfile and best-effort spawn `fez sentinel` when
  the CLI exists; a mention of @fez with no reply in 60s raises a sticky toast; FirstRun is
  readiness-aware (points at Settings → Agents instead of suggesting a mention that will
  hang); the scripted @fez opener states the gap in-channel. Bundling the full runner chain
  (sentinel → fez agent → fez-acp) into the DMG is the standalone follow-up.
- [x] **Extension install can panic.** DONE: the settings closure uses a shape-normalizing
  `obj_entry` helper (resets wrong-typed members) instead of `.unwrap()` chains.
- [x] **settings.json truncation risk.** DONE: serialize failures now propagate as errors at
  both sites instead of writing an empty file.
- [x] **`wire_chutes_pi` clobbers pi config.** DONE: a `local-models.json` that isn't the JSON
  array pi expects is now an error ("fix or remove it, then retry"), never overwritten.
  Residual: the Chutes API key still lands in that file in plaintext — that's pi's own config
  format, not ours to change.
- [x] **No error boundary.** DONE: `RootErrorBoundary` in `main.tsx` — render throws show the
  message + a try-again instead of a white window.

## Tier 3 — trust and polish

- [x] **Rename bundle identifier.** DONE: `com.fez.desktop`, and `productName` → "fez" (the
  Dock/Finder label; the bundle is now fez.app). Landed before any public build, so no
  keychain-ACL/TCC reset for real users.
- [x] **Replace scaffold branding.** DONE: page/window titles → "fez", vite/tauri scaffold
  svgs deleted, Cargo.toml description/authors fixed, and the stock Tauri icons replaced —
  `scripts/make-icon.mjs` renders the site wordmark (white mono "fez" + ember ▴ on black)
  to app-icon.png; the full set regenerates with `npx tauri icon app-icon.png`.
- [x] **Find-and-replace damage in visible copy.** DONE: all "client.state.workspace" strings
  in ManagePane restored to "workspace".
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
- [x] **Minimum OS is a lie.** DONE: `bundle.macOS.minimumSystemVersion: "13.0"` in
  tauri.conf.json — matches what the bundled `pi` actually requires.
- [ ] **Release build can silently ship agent-less.** PARTIAL: `PI_REF` now defaults to the
  `v<PI_VERSION>` tag (verified it exists) instead of an unpinned default-branch clone.
  Still open: the bun-absent path exits 0 by design for dev builds — a release CI job must
  set `REQUIRE_PI_AGENT=1` (the hard-fail already exists), and that CI job doesn't exist yet.

## Papercuts

- [x] Draft cleared before unguarded `await` — DONE: channel send, DM send, and JoinByCode all
  restore the input and toast the error on failure.
- [x] Desktop copy points at TUI/CLI — DONE: FindSource, RemindersPane, and the solo-channel
  note all reworded.
- [x] `ModelPicker` swallows the `wire_chutes_pi` error — DONE: real failures render in the
  hint; the expected "no Chutes key" case stays quiet (the no-models hint covers it).
- [x] Harness detection — DONE: added `~/.bun/bin`, volta, deno, asdf shims, `~/Library/pnpm`
  + `$PNPM_HOME`; check is now is-file + executable-bit, not mere existence. (Wrong-arch
  binaries still pass — an arch probe is part of the Intel-story item in Tier 1.)
- [ ] Agent create form allows harness=pi with no provider/model; success screen promises a spawn
  that will never happen (`AgentsPane.tsx:690-736,743-753`). PARTIAL: `harnesses.ts` no longer
  defaults unknown harnesses to "installed" (optimistic only while detection is in flight);
  the form-side gating is still open.
- [ ] Offline first launch looks like an empty-but-working app. PARTIAL: reconnect now backs
  off exponentially (2s→30s, watchdog respects it). Still open: NIP-11 failure renders an
  owned workspace as "unclaimed", queries resolve `[]` after 5s, splash dismisses regardless.
- [x] `write_skill`/`remove_skill` miss `create_dir_all` — DONE, both mkdir first.
- [ ] MCP skill install writes `npx …` commands verbatim with no node/npx check; failure happens
  later in a process the app doesn't own (`SkillsView.tsx:782-812`).
- [x] `ureq` hardening — DONE: 30s timeouts on all registry/Chutes calls (120s for the tarball),
  30MB download / 120MB decompressed caps, and non-https tarball URLs refused. (Shasum verify
  skipped deliberately: the hash comes from the same origin as the tarball, so it adds nothing
  over TLS here.)
- [ ] `ModelPicker.tsx:14` duplicates the hash-derived Chutes provider id from `lib.rs:378` with
  no shared source.
- [x] Stale theme files — DONE: the theme dir is replaced wholesale on each agent install.
