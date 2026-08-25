# Cold-Start Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cold DMG downloader lands in a local workspace they own, with a client-signed @fez greeting that is honest about whether a real reply is possible.

**Architecture:** Bundle `fez-relay` the way pi is bundled (bun-compile → Tauri resources → `~/.fez/bin`). The Tauri backend spawns and babysits the local relay (pidfile + NIP-11 health check). The webview seeds a Welcome opener signed by a local `agent:fez` key, idempotent via a `["client", …]` event marker on the relay. A readiness probe (existing `detect_harnesses` + `has_skill_secret` + new `runner_status`) picks the opener copy. Pairing keeps the hosted relay as rendezvous only.

**Tech Stack:** Tauri 2 (Rust), React webview, `@fezchat/client` (`FezClient`/`BrowserWire`), bun `--compile`, fez-relay (`packages/fez-relay`), vitest via `packages/fez-evals`.

**Spec:** `docs/superpowers/specs/2026-08-24-cold-start-onboarding-design.md`

## Global Constraints

- Default relay value: `ws://127.0.0.1:7777` (replaces `wss://67-205-188-204.sslip.io` in `packages/fez-desktop/src/relay.ts` — the ONLY site).
- Hosted relay `wss://67-205-188-204.sslip.io` survives only as `PAIRING_RELAY` (rendezvous) — never as a workspace default.
- Opener markers: `fez-welcome.opener.v1`, `fez-welcome.awake.v1` — exact strings, versioned, never reused.
- All scripted messages are client-signed by the `agent:fez` key; no message is ever fabricated as LLM output; degraded states use panel notes, not messages.
- Local relay listens on `127.0.0.1` only. Store: `~/.fez/relay/events.jsonl`. Pidfile: `~/.fez/relay/relay.pid`.
- The desktop bundle must not import from the CLI package (root `src/`); duplicated constants carry a comment naming the source of truth (existing convention, see `wire.ts`).
- `onboarding-tier1` conventions: extend `copy_agent_files` (staging + quarantine strip + atomic rename) rather than adding a parallel copy path; graceful-when-absent for dev builds, `REQUIRE_PI_AGENT=1` hard-fails in release CI.
- Existing users must be untouched: everyone onboarded has `localStorage["fez-relay"]`, which outranks the default; never migrate a stored relay set; never spawn a local relay for an identity without the `~/.fez/relay/` marker dir.
- Commit after each task on the current working branch; do not push (Ken pushes).

---

### Task 1: Bundle fez-relay into the app resources

**Files:**
- Modify: `packages/fez-desktop/scripts/prepare-pi-agent.mjs`
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (`copy_agent_files`, ~line 1205)

**Interfaces:**
- Produces: `~/.fez/bin/fez-relay` (executable) on machines whose app bundle carried it; absent on dev builds without bun (graceful).

- [ ] **Step 1: Extend the prepare script to compile fez-relay**

In `prepare-pi-agent.mjs`, after the pi-acp section (before the VERSION stamp), add:

```js
// ── fez-relay: the local-workspace relay, bundled like pi ──────────────
// Compiled from the monorepo source (ws + nostr-tools only — no native
// deps), so the DMG can spawn a user-owned workspace with no install.
const RELAY_SRC = path.resolve(HERE, "..", "..", "fez-relay", "src", "cli.ts");
const relayOut = path.join(OUT, `fez-relay${EXE}`);
if (hasBun()) {
  run(`bun build --compile "${RELAY_SRC}" --outfile "${relayOut}"`, path.resolve(HERE, "..", "..", "fez-relay"));
  fs.chmodSync(relayOut, 0o755);
} else if (process.env.REQUIRE_PI_AGENT === "1") {
  console.error("bun is required to bundle fez-relay for a release build");
  process.exit(1);
} else {
  console.log("bun absent — skipping fez-relay bundle (local workspace falls back to hosted-relay-by-invite)");
}
```

Also update the top-of-file comment's "Steps:" line to mention fez-relay.

- [ ] **Step 2: Verify the script produces the binary**

Run: `cd packages/fez-desktop && FORCE=1 npm run prepare-pi-agent && file src-tauri/pi-agent/fez-relay`
Expected: `Mach-O 64-bit executable arm64` (on this machine). If bun is absent, expected: the skip message and no file.

- [ ] **Step 3: Smoke-run the compiled relay**

Run: `./packages/fez-desktop/src-tauri/pi-agent/fez-relay --port 7999 --store /tmp/fez-relay-smoke.jsonl & sleep 1 && curl -s -H "Accept: application/nostr+json" http://127.0.0.1:7999 | head -c 200; kill %1`
Expected: a NIP-11 JSON document.

- [ ] **Step 4: Teach `copy_agent_files` about the optional binary**

In `lib.rs`, change the executable loop (currently `for name in ["pi", "pi-acp"]`) to distinguish required from optional:

```rust
    // fez-relay is optional: dev builds without bun don't produce it, and
    // the app degrades to invite-only workspaces. pi/pi-acp stay required.
    for (name, required) in [("pi", true), ("pi-acp", true), ("fez-relay", false)] {
        if !required && !src.join(name).exists() {
            continue;
        }
        let staged = bin.join(format!(".{name}.staging"));
        let dst = bin.join(name);
        std::fs::copy(src.join(name), &staged).map_err(|e| format!("copy {name}: {e}"))?;
        // … (rest of the existing loop body unchanged: chmod, xattr strip, rename)
```

Keep every existing line of the loop body; only the iterator and the `continue` guard change.

- [ ] **Step 5: Build the Rust side to verify it compiles**

Run: `cd packages/fez-desktop/src-tauri && cargo check 2>&1 | tail -3`
Expected: `Finished` with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-desktop/scripts/prepare-pi-agent.mjs packages/fez-desktop/src-tauri/src/lib.rs
git commit -m "desktop: bundle fez-relay beside pi — the local workspace ships in the DMG"
```

---

### Task 2: Rust — local relay lifecycle (`ensure_local_relay`, `local_relay_status`)

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (new commands + `.setup()` hook + `generate_handler!` list, ~line 1259)

**Interfaces:**
- Produces: Tauri commands
  - `ensure_local_relay(owner: String, name: String) -> Result<String, String>` — spawns/adopts the relay, returns `"ws://127.0.0.1:7777"` once NIP-11 answers; `Err` with a human message otherwise.
  - `local_relay_status() -> bool` — pidfile alive.
- Marker: the existence of `~/.fez/relay/` (created only by `ensure_local_relay`) means "this machine chose a local workspace"; `.setup()` respawns on that marker.

- [ ] **Step 1: Write the commands**

Add to `lib.rs` (near the other `#[tauri::command]` fns):

```rust
fn fez_relay_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".fez").join("relay")
}

fn pid_alive(pidfile: &std::path::Path) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(pidfile).ok()?.trim().parse().ok()?;
    // kill -0: alive and ours. libc-free via /bin/kill to match the
    // no-extra-crates convention in this file.
    let ok = Command::new("/bin/kill").args(["-0", &pid.to_string()]).output()
        .map(|o| o.status.success()).unwrap_or(false);
    ok.then_some(pid)
}

/// Is the local workspace relay running? Pidfile + kill -0, same
/// convention as the CLI sentinel's pidfile.
#[tauri::command]
fn local_relay_status() -> bool {
    pid_alive(&fez_relay_dir().join("relay.pid")).is_some()
}

/// Spawn (or adopt) the user-owned local relay and wait until its NIP-11
/// answers. Creating ~/.fez/relay is the durable "this machine chose a
/// local workspace" marker — .setup() respawns on it every launch.
#[tauri::command]
fn ensure_local_relay(owner: String, name: String) -> Result<String, String> {
    let dir = fez_relay_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let pidfile = dir.join("relay.pid");
    if pid_alive(&pidfile).is_none() {
        let home = std::env::var("HOME").unwrap_or_default();
        let bin = std::path::PathBuf::from(&home).join(".fez").join("bin").join("fez-relay");
        if !bin.exists() {
            return Err("fez-relay isn't bundled in this build — join a workspace by invite instead".into());
        }
        let child = Command::new(&bin)
            .args([
                "--port", "7777",
                "--store", &dir.join("events.jsonl").to_string_lossy(),
                "--owner", &owner,
                "--name", &name,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn fez-relay: {e}"))?;
        std::fs::write(&pidfile, child.id().to_string()).map_err(|e| format!("pidfile: {e}"))?;
    }
    // Health: NIP-11 on the http origin, up to 5s. ureq is already a dep.
    for _ in 0..10 {
        if ureq::get("http://127.0.0.1:7777")
            .set("Accept", "application/nostr+json")
            .timeout(std::time::Duration::from_millis(500))
            .call()
            .is_ok()
        {
            return Ok("ws://127.0.0.1:7777".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err("local relay didn't come up within 5s — check ~/.fez/relay".into())
}
```

(If `--name` needs quoting or the relay rejects an empty name, pass `"your workspace"` from the caller — Task 3 does.)

- [ ] **Step 2: Respawn on launch**

In `.setup()` (~line 1249), after the `install_bundled_agent` thread spawn, add:

```rust
            // A machine that chose a local workspace gets its relay back
            // on every launch — before the webview boots and connects.
            if fez_relay_dir().exists() {
                std::thread::spawn(|| {
                    // Owner/name only matter at claim time; a restart
                    // reuses the store, whose NIP-11 identity is durable.
                    let _ = ensure_local_relay(String::new(), String::new());
                });
            }
```

Check `packages/fez-relay/src/cli.ts` first: if `--owner ""`/`--name ""` at restart would *overwrite* the stored identity, read owner back from the NIP-11 in `events.jsonl` metadata or simply persist the original flags to `~/.fez/relay/args.json` at first spawn and reuse them. Implement whichever the relay's flag semantics require — the invariant is: **a restart never changes the workspace's owner or name.**

- [ ] **Step 3: Register the commands**

Add `ensure_local_relay, local_relay_status` to the `generate_handler![…]` list.

- [ ] **Step 4: Verify compile + manual spawn**

Run: `cd packages/fez-desktop/src-tauri && cargo check 2>&1 | tail -3`
Expected: `Finished`, no errors.
Then manually: copy the Task-1 binary to `~/.fez/bin/fez-relay`, and from a scratch Rust test or `npm run tauri dev` console call `ensure_local_relay` with a hex pubkey; verify `curl -s -H "Accept: application/nostr+json" http://127.0.0.1:7777` names that pubkey, and `~/.fez/relay/relay.pid` holds a live pid.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src-tauri/src/lib.rs
git commit -m "desktop: the app owns a local relay — spawn, claim, health-check, respawn on launch"
```

---

### Task 3: Frontend default flip + onboarding wiring + pairing rendezvous

**Files:**
- Modify: `packages/fez-desktop/src/relay.ts`
- Modify: `packages/fez-desktop/src/Onboarding.tsx` (`start()` ~line 56, `PairingStep` usage ~line 152)

**Interfaces:**
- Consumes: `ensure_local_relay(owner, name)` from Task 2.
- Produces: `PAIRING_RELAY` export in `relay.ts`; `DEFAULT_RELAY === "ws://127.0.0.1:7777"`.

- [ ] **Step 1: Flip the default, add the rendezvous constant**

In `relay.ts`, replace the `DEFAULT_RELAY` declaration and its doc comment:

```ts
/**
 * The ONE home of the relay default (see git history for the four-literal
 * era). The default is now the LOCAL workspace relay the app spawns and
 * claims for a fresh identity (ensure_local_relay, Rust side) — a cold
 * downloader lands in a workspace they own, not on someone's hosted box.
 * Existing installs are unaffected: onboarding always wrote
 * localStorage["fez-relay"], which outranks this.
 */
export const DEFAULT_RELAY = "ws://127.0.0.1:7777";

/**
 * Device pairing needs a relay BOTH machines can reach — a loopback
 * default cannot rendezvous. Pairing-only; never a workspace default.
 */
export const PAIRING_RELAY = "wss://67-205-188-204.sslip.io";
```

- [ ] **Step 2: Route pairing through the rendezvous**

In `Onboarding.tsx`, import `PAIRING_RELAY` and change the `PairingStep` invocation:

```tsx
        {step === "pairing" && (
          <PairingStep
            relayUrl={PAIRING_RELAY}
            onPaired={(hex) => {
```

(The paired identity's *workspace* relay still comes from the normal flow; only the key exchange rides the hosted relay.)

- [ ] **Step 3: Spawn the local workspace on the plain path**

In `Onboarding.tsx` `start()`, after `await invoke("set_identity", …)` and before the profile publish, add — only when no invite is pending:

```ts
      // Cold path (no invite): this machine becomes the workspace.
      // An invite instead means joining THEIR relay — no local spawn.
      if (!localStorage.getItem("fez-pending-invite")) {
        const pk = getPublicKey(secret);
        const url = await invoke<string>("ensure_local_relay", {
          owner: pk,
          name: name.trim() ? `${name.trim()}'s workspace` : "your workspace",
        });
        setRelayUrl(url);
        localStorage.setItem("fez-relay", url);
      }
```

`getPublicKey` is already imported. Note `localStorage.setItem("fez-relay", relayUrl)` two lines below must not clobber this — reorder so the invite-less path's `setItem` above is the last write (move the existing `setItem` into an `else` branch).

- [ ] **Step 4: Typecheck + lint**

Run: `cd packages/fez-desktop && npx tsc --noEmit && npx eslint src/relay.ts src/Onboarding.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/relay.ts packages/fez-desktop/src/Onboarding.tsx
git commit -m "desktop: cold users get a local workspace; pairing keeps the hosted relay as rendezvous only"
```

---

### Task 4: Welcome core — persona, agent key, opener logic (pure module)

**Files:**
- Create: `packages/fez-desktop/src/welcome-core.ts` (pure — no tauri imports, testable from fez-evals)
- Create: `packages/fez-desktop/src/welcome.ts` (tauri-facing wrapper)
- Test: `packages/fez-evals/tests/welcome-opener.test.ts` (written in Task 6)

**Interfaces:**
- Consumes: `get_identity`/`set_identity` (existing, with `account: "agent:fez"`), `write_persona`/`read_persona` (existing), `detect_harnesses` (existing → `{"claude-code": bool, "pi": bool}`), `has_skill_secret` (existing, `"chutes.CHUTES_API_KEY"`), `local_relay_status` + `runner_status` (Task 2 / Task 5).
- Produces:
  - `welcome-core.ts`: `OPENER_MARKER = "fez-welcome.opener.v1"`, `AWAKE_MARKER = "fez-welcome.awake.v1"`, `openerText(r: Readiness, userName: string): string`, `awakeText(): string`, `ensureMarkedMessage(wire: MarkerWire, channelId: string, userPk: string, marker: string, text: string): Promise<boolean>` (true = published, false = already present), types `Readiness { authed: boolean; runner: boolean }` and `MarkerWire { existing(channelId: string): Promise<string[][][]>; publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<unknown> }`.
  - `welcome.ts`: `ensureWelcome(client: FezClient): Promise<void>` — the one call App.tsx makes (Task 5).

- [ ] **Step 1: Write `welcome-core.ts`**

```ts
/**
 * The scripted half of the welcome choreography — everything here is
 * client-signed and deterministic; no LLM output ever passes through
 * this module. Pure (no tauri imports) so fez-evals can test it.
 *
 * Idempotency lives on the RELAY, not in local state: each scripted
 * message carries a ["client", <marker>] tag, and we skip publishing
 * when any message in the channel already carries it. Reinstalls,
 * paired second devices, and re-runs all converge on one greeting.
 */
export const OPENER_MARKER = "fez-welcome.opener.v1";
export const AWAKE_MARKER = "fez-welcome.awake.v1";

/** Message kind — mirrors K.MESSAGE in @fezchat/client (source of truth). */
export const KIND_MESSAGE = 47103;

export interface Readiness {
  /** A model can answer: claude-code harness present, or pi + a key. */
  authed: boolean;
  /** Something watches mentions: the sentinel (or equivalent) is alive. */
  runner: boolean;
}

export interface MarkerWire {
  /** Tag arrays of every message already in the channel. */
  existing(channelId: string): Promise<string[][][]>;
  publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<unknown>;
}

export function openerText(r: Readiness, userName: string): string {
  const hello = userName ? `Welcome, ${userName}.` : "Welcome.";
  const base =
    `🎩 ${hello} This is your workspace — it runs on this machine, and your ` +
    `identity is a key in your keychain, not an account on a server. ` +
    `I'm @fez, your guide: ask me anything about fez, or hand me a task ` +
    `and I'll bring in the right agent.`;
  if (r.authed && r.runner) {
    return `${base}\n\nTry it: mention @fez what can you do?`;
  }
  if (r.authed && !r.runner) {
    return (
      `${base}\n\nOne thing first: nothing is listening for mentions yet. ` +
      `Start the watcher with \`fez sentinel\` in a terminal (or install the ` +
      `fez CLI), then mention me.`
    );
  }
  return (
    `${base}\n\nOne thing first: I need a model to think with. ` +
    `Connect one in Settings → Agents (Claude Code login or an API key), ` +
    `then come back and mention me.`
  );
}

export function awakeText(): string {
  return "🎩 I'm awake — a model is connected. Try: @fez what can you do?";
}

/**
 * Publish `text` as a marked scripted message unless the marker already
 * exists in the channel. Returns whether a publish happened.
 */
export async function ensureMarkedMessage(
  wire: MarkerWire,
  channelId: string,
  userPk: string,
  marker: string,
  text: string
): Promise<boolean> {
  const tagSets = await wire.existing(channelId);
  const seen = tagSets.some((tags) => tags.some((t) => t[0] === "client" && t[1] === marker));
  if (seen) return false;
  await wire.publish({
    kind: KIND_MESSAGE,
    tags: [
      ["h", channelId],
      ["p", userPk], // p-tags the user so the inbox isn't empty on day one
      ["client", marker],
    ],
    content: text,
  });
  return true;
}
```

(`47103` verified against `packages/fez-client/src/index.ts:190`.)

- [ ] **Step 2: Write `welcome.ts` (tauri-facing)**

```ts
/**
 * Wires welcome-core to the running app: ensures the @fez persona and
 * its local agent key exist, computes readiness from what this machine
 * actually has, and posts the scripted opener (and later the awake
 * line) signed by the agent key. Desktop-owned duplicate of the CLI's
 * starter @fez (src/identity/fez-persona.ts is the source of truth for
 * the persona text) — the bundle deliberately doesn't import the CLI.
 */
import { invoke } from "@tauri-apps/api/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { FezClient } from "@fezchat/client";
import { BrowserWire } from "./wire";
import { relaySet } from "./relay";
import {
  OPENER_MARKER, AWAKE_MARKER, KIND_MESSAGE,
  openerText, awakeText, ensureMarkedMessage, type Readiness, type MarkerWire,
} from "./welcome-core";

const AGENT_ACCOUNT = "agent:fez";

const FEZ_PERSONA_MD = `---
harness: {{HARNESS}}
aliases: [orchestrator]
description: your guide to fez — ask how anything works, or hand over a task and the right agent gets it
---
You are @fez, the guide for this fez workspace. Answer questions about fez
plainly; for tasks, name the persona best suited and offer to bring it in.
`;

async function ensureFezPersona(harness: string): Promise<void> {
  try {
    await invoke("read_persona", { name: "fez" });
  } catch {
    await invoke("write_persona", { name: "fez", content: FEZ_PERSONA_MD.replace("{{HARNESS}}", harness) });
  }
}

async function agentKeyHex(): Promise<string> {
  try {
    return await invoke<string>("get_identity", { account: AGENT_ACCOUNT });
  } catch {
    const hex = bytesToHex(generateSecretKey());
    await invoke("set_identity", { hex, account: AGENT_ACCOUNT });
    return hex;
  }
}

export async function readiness(): Promise<Readiness> {
  const harnesses = await invoke<Record<string, boolean>>("detect_harnesses");
  const chutes = await invoke<boolean>("has_skill_secret", { skill: "chutes", key: "CHUTES_API_KEY" }).catch(() => false);
  const runner = await invoke<boolean>("runner_status").catch(() => false);
  return { authed: !!harnesses["claude-code"] || (!!harnesses["pi"] && chutes), runner };
}

function markerWire(hex: string): MarkerWire & { close(): void } {
  const wire = new BrowserWire(relaySet(), hex);
  return {
    async existing(channelId) {
      // Real relay query, same shape FezClient's history load uses
      // (wire.query([{ kinds: [K.MESSAGE], "#h": [id], … }])).
      const events = await wire.query([{ kinds: [KIND_MESSAGE], "#h": [channelId], limit: 500 }]);
      return (events as { tags: string[][] }[]).map((e) => e.tags);
    },
    publish: (tmpl) => wire.publish(tmpl),
    close: () => wire.close(),
  };
}

/** The one call App.tsx makes after the owner bootstrap (Task 5). */
export async function ensureWelcome(client: FezClient): Promise<void> {
  // Only in a local workspace the user owns; never on joined relays.
  if (!relaySet()[0].startsWith("ws://127.0.0.1")) return;
  if (!client.state.isOwner(client.pubkey)) return;
  const channel = client.state.workspace.channels.get("bootstrap-general");
  if (!channel) return;

  const harnesses = await invoke<Record<string, boolean>>("detect_harnesses");
  await ensureFezPersona(harnesses["claude-code"] ? "claude-code" : "pi");
  const hex = await agentKeyHex();
  const r = await readiness();
  const userName = localStorage.getItem("fez-name") ?? "";
  const w = markerWire(hex);
  try {
    const posted = await ensureMarkedMessage(w, channel.id, client.pubkey, OPENER_MARKER, openerText(r, userName));
    // The awake line only ever follows a NOT-ready opener. Ready-now +
    // no awake yet + opener present ⇒ auth appeared since the opener.
    if (!posted && r.authed && r.runner) {
      await ensureMarkedMessage(w, channel.id, client.pubkey, AWAKE_MARKER, awakeText());
    }
  } finally {
    w.close();
  }
}
```

One adjust-to-reality point: verify `BrowserWire`'s query/close method names against `packages/fez-desktop/src/wire.ts` (the wire interface at `packages/fez-client/src/index.ts:81` defines `publish`; `query` is used at `index.ts:1568`) — the compile will flag any mismatch. The awake-line condition has a deliberate quirk: posting the opener in a ready state and *then* the awake check both passing would double-greet — the `!posted` guard prevents it.

Also: `Onboarding.tsx` must store the chosen display name — in `start()`, alongside the relay write, add `localStorage.setItem("fez-name", name.trim())`.

- [ ] **Step 3: Typecheck**

Run: `cd packages/fez-desktop && npx tsc --noEmit`
Expected: clean (after the adjust-to-reality pass above).

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/src/welcome-core.ts packages/fez-desktop/src/welcome.ts packages/fez-desktop/src/Onboarding.tsx
git commit -m "desktop: the room is never empty — client-signed @fez opener with relay-side idempotency"
```

---

### Task 5: Boot integration + runner detection + no-reply honesty

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (`runner_status`, `ensure_agent_runner` commands)
- Modify: `packages/fez-desktop/src/App.tsx` (`bootOnce` ~line 160; composer send path ~line 1644)
- Modify: `packages/fez-desktop/src/FirstRun.tsx`

**Interfaces:**
- Consumes: `ensureWelcome(client)`, `readiness()` from Task 4.
- Produces: `runner_status() -> bool`, `ensure_agent_runner() -> Result<bool, String>` (true = runner alive or spawned; false = no way to run one here).

- [ ] **Step 1: Rust — runner detection and best-effort spawn**

```rust
/// Something is watching mentions: the CLI sentinel's pidfile is alive.
#[tauri::command]
fn runner_status() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    pid_alive(&std::path::PathBuf::from(home).join(".fez").join("sentinel.pid")).is_some()
}

/// Best effort: if the fez CLI exists on this machine, start its sentinel
/// detached. Ok(false) means "no CLI here" — the UI says so honestly
/// instead of promising a reply that cannot come.
#[tauri::command]
fn ensure_agent_runner() -> Result<bool, String> {
    if runner_status() {
        return Ok(true);
    }
    // Same real-install-dirs search harness_installed uses.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.fez/bin/fez"),
        "/opt/homebrew/bin/fez".into(),
        "/usr/local/bin/fez".into(),
        format!("{home}/.local/bin/fez"),
        format!("{home}/.bun/bin/fez"),
        format!("{home}/.volta/bin/fez"),
    ];
    let Some(fez) = candidates.iter().find(|p| std::path::Path::new(p.as_str()).exists()) else {
        return Ok(false);
    };
    Command::new(fez)
        .arg("sentinel")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn fez sentinel: {e}"))?;
    Ok(true)
}
```

Register both in `generate_handler![…]`. Run `cargo check` — expected clean.

- [ ] **Step 2: Call the welcome flow from boot**

In `App.tsx` `bootOnce`, directly after the `ensureChannel({ name: "general", id: "bootstrap-general" })` block:

```ts
    // Local-workspace owners get the scripted @fez greeting (idempotent —
    // relay-side markers). Non-blocking: a slow relay must not hold boot.
    void import("./welcome").then(async ({ ensureWelcome }) => {
      await invoke("ensure_agent_runner").catch(() => {});
      await ensureWelcome(client);
    }).catch(() => {});
```

- [ ] **Step 3: The 60-second honesty timer**

In the composer send path in `App.tsx` (where a channel message is sent), after a successful send that mentions `@fez` (reuse however mentions are detected for `mentionPks`; if the send path has the mentioned names, match on `"fez"`):

```ts
    // A mention that nothing answers must say why. 60s, then a panel
    // note (never a fabricated message) — mirrors FirstRun's honesty rule.
    if (mentionedNames.includes("fez")) {
      const before = client.state.messages(channelId).length;
      setTimeout(() => {
        const msgs = client.state.messages(channelId);
        const replied = msgs.slice(before).some((m) => client.agents().get(m.authorPk)?.toLowerCase() === "fez");
        if (!replied) {
          toast.info("@fez didn't answer in 60s — check Agents (is a model connected? is the watcher running?)", 0);
        }
      }, 60_000);
    }
```

Adapt the exact accessors (`client.state.messages`, `client.agents()`) to the real API at the send site — both patterns appear in `FirstRun.tsx` and the timeline rendering; reuse those. `toast.info(text, 0)` is the tier-1 sticky-toast convention.

- [ ] **Step 4: FirstRun gains the not-ready state**

In `FirstRun.tsx`, add a `ready?: boolean` prop (App passes it from `readiness()`, cached in state). In the `hasFez` branch, when `ready === false`, replace the "Try @fez…" paragraph with:

```tsx
          <p className="fr-ok">
            @fez needs a model to think with — connect one in{' '}
            <button className="fr-link" onClick={onOpenAgents}>Settings → Agents</button>, then mention{' '}
            <span className="fr-try">@fez</span> here.
          </p>
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `cd packages/fez-desktop && npx tsc --noEmit && npx eslint src && cd src-tauri && cargo check 2>&1 | tail -2`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-desktop/src-tauri/src/lib.rs packages/fez-desktop/src/App.tsx packages/fez-desktop/src/FirstRun.tsx
git commit -m "desktop: mentions answer or say why they can't — runner detection, 60s honesty, ready-aware FirstRun"
```

---

### Task 6: fez-evals coverage

**Files:**
- Create: `packages/fez-evals/tests/welcome-opener.test.ts`

**Interfaces:**
- Consumes: `welcome-core.ts` exports (Task 4) via relative import (precedent: fez-evals already imports `../../fez-desktop/src/wire.ts`-adjacent modules and root `src/`); `packages/fez-relay/dist/cli.js` (built by `npm run build`).

- [ ] **Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  OPENER_MARKER, openerText, awakeText, ensureMarkedMessage, type MarkerWire,
} from "../../fez-desktop/src/welcome-core.js";

describe("welcome opener", () => {
  it("copy matrix: every readiness state says something true and actionable", () => {
    const live = openerText({ authed: true, runner: true }, "Ken");
    expect(live).toContain("@fez what can you do?");
    const noRunner = openerText({ authed: true, runner: false }, "Ken");
    expect(noRunner).toContain("fez sentinel");
    expect(noRunner).not.toContain("what can you do?"); // no dead invitation
    const noAuth = openerText({ authed: false, runner: false }, "");
    expect(noAuth).toContain("Settings → Agents");
    expect(noAuth).toContain("Welcome."); // empty name degrades cleanly
    expect(awakeText()).toContain("@fez");
  });

  it("marker idempotency: second ensure publishes nothing", async () => {
    const published: { tags: string[][] }[] = [];
    const wire: MarkerWire = {
      existing: async () => published.map((e) => e.tags),
      publish: async (tmpl) => { published.push(tmpl); return {}; },
    };
    const first = await ensureMarkedMessage(wire, "ch1", "pk1", OPENER_MARKER, "hello");
    const second = await ensureMarkedMessage(wire, "ch1", "pk1", OPENER_MARKER, "hello");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0].tags).toContainEqual(["client", OPENER_MARKER]);
    expect(published[0].tags).toContainEqual(["p", "pk1"]);
  });

  it("spawned relay claims its owner in NIP-11", async () => {
    const owner = "a".repeat(64);
    const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fez-relay-test-")), "events.jsonl");
    const cli = path.resolve(__dirname, "../../fez-relay/dist/cli.js");
    const port = 7911;
    const child = spawn("node", [cli, "--port", String(port), "--store", store, "--owner", owner, "--name", "test workspace"], { stdio: "ignore" });
    try {
      let info: { pubkey?: string; name?: string } | undefined;
      for (let i = 0; i < 20 && !info; i++) {
        await new Promise((r) => setTimeout(r, 250));
        info = await fetch(`http://127.0.0.1:${port}`, { headers: { Accept: "application/nostr+json" } })
          .then((r) => r.json() as Promise<{ pubkey?: string; name?: string }>)
          .catch(() => undefined);
      }
      expect(info?.pubkey).toBe(owner);
      expect(info?.name).toBe("test workspace");
    } finally {
      child.kill();
    }
  });
});
```

- [ ] **Step 2: Run the new file, watch it fail correctly first**

Run: `cd packages/fez-evals && npx vitest run tests/welcome-opener.test.ts`
Before Task 4 lands this fails on the import (correct); after, expected: 3 passed. If the NIP-11 field for the name differs (e.g. only `pubkey` is served), assert on what `packages/fez-relay/src/cli.ts` actually serves — read it, don't guess.

- [ ] **Step 3: Full suite regression**

Run: `cd packages/fez-evals && npm test 2>&1 | tail -3`
Expected: everything passes (800+ including the 3 new).

- [ ] **Step 4: Commit**

```bash
git add packages/fez-evals/tests/welcome-opener.test.ts
git commit -m "evals: welcome opener — copy matrix, marker idempotency, relay claims its owner"
```

---

### Task 7: End-to-end verification (manual, clean environment)

**Files:** none (verification only; fixes discovered here get their own commits).

- [ ] **Step 1: Build the app**

Run: `cd packages/fez-desktop && npm run tauri build 2>&1 | tail -5`
Expected: a `fez.app` bundle with `pi-agent/fez-relay` in its resources.

- [ ] **Step 2: Cold-user pass (clean macOS user account, or `HOME=$(mktemp -d)` shim where feasible)**

1. Launch the app with no `~/.fez` → onboarding → type a name → "get started".
2. Expect: land in `#general` of "<name>'s workspace"; the @fez opener is visible; `~/.fez/relay/relay.pid` alive; `curl -s -H "Accept: application/nostr+json" http://127.0.0.1:7777` names your pubkey.
3. Quit + relaunch → relay respawns, **no second opener**.
4. With Claude Code logged in on the machine + `fez sentinel` running: mention `@fez what can you do?` → a real reply arrives.
5. With neither: opener shows the Settings → Agents copy; add a Chutes key; relaunch → the awake line appears exactly once; mention @fez with the sentinel stopped → sticky toast at 60s.
6. Invite path regression: paste an invite during onboarding → NO local relay dir is created, the invite relay is the workspace.
7. Pairing regression: "I use fez on another device" → the pairing URI names the hosted relay, and `fez pair send` from the old machine completes.

- [ ] **Step 3: Record outcomes**

Check off the matching items in `ONBOARDING.md` (the "@fez never answers" Tier-2 item) with a one-line DONE note, same style as the others. Commit:

```bash
git add ONBOARDING.md
git commit -m "docs: ONBOARDING — @fez-never-answers closed by the cold-start work"
```
