# Onboarding Buzz-Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buzz-shaped onboarding for fez-desktop — harness/defaults/community/profile/team wizard pages, desktop-managed starter agents (@fez/@drift/@quill, no sentinel in the GUI), and the welcome-kickoff choreography landing in a dedicated #welcome channel — all GUI-tested with a new Playwright suite.

**Architecture:** Extend the existing `ob-card` step flow in `Onboarding.tsx`; the Tauri backend gains a `managed_agents` module (Buzz's shape) that spawns/reconciles `~/.fez/bin/fez-agent` children; `wire_chutes_pi` generalizes to a provider table (Chutes/Anthropic/OpenAI/OpenRouter); welcome-core's existing choreography is renamed (@drift/@quill), rostered properly, and retargeted at `bootstrap-welcome`. GUI tests: Playwright against the built vite bundle with a mocked `window.__TAURI_INTERNALS__` bridge + the real `fez-relay` where wire traffic matters.

**Tech Stack:** React 19 + Vite 7 (webview), Tauri 2 (Rust), nostr-tools, vitest (fez-evals), @playwright/test (new), bundled pi 0.84.2 / pi-acp 0.0.33.

**Spec:** `docs/superpowers/specs/2026-08-25-onboarding-buzz-flow-design.md`

## Global Constraints

- The GUI never spawns or depends on the sentinel (spec decision 9). Desktop defers to a live `~/.fez/sentinel.pid`; never double-spawn a persona.
- Key custody: keychain service `fez-keys`, account `agent:<name>` for every agent identity — desktop Rust `get_identity`/`set_identity` already use this service (lib.rs:51-61,223-225). Never store keys anywhere else.
- Provider keys go through `set_skill_secret` (keychain service `fez-skill-env`, account `<skill>.<KEY>`), never localStorage.
- Starter personas: ids exactly `drift` (researcher) and `quill` (scribe); guide stays `fez`.
- Welcome channel: fixed id `bootstrap-welcome`, name `welcome`, `visibility: "closed"`.
- Providers v1 exactly: Chutes, Anthropic, OpenAI, OpenRouter — data-driven table, one entry to add more.
- Effort levels UI: `low | medium | high` mapping to pi `defaultThinkingLevel` (pi also has `minimal`; we don't expose it).
- Skip never soft-locks: every wizard step reachable from the last must have a skip/later path.
- E2E-before-ship: desktop releases only after `e2e-cold-start.sh` passes on the mini.
- No co-author/session trailers in commits.
- All fez-desktop pure-TS logic is tested from `packages/fez-evals` (vitest, imports desktop src via `../../fez-desktop/src/*.js`). Playwright lives in `packages/fez-desktop/tests/e2e`.
- Run `npm run check` (tsc --noEmit) in `packages/fez-desktop` before every commit that touches its TS.

---

### Task 1: Rename the starter team to @drift and @quill

**Files:**
- Modify: `packages/fez-desktop/src/welcome-core.ts:98-111` (STARTER_TEAM)
- Test: `packages/fez-evals/tests/welcome-opener.test.ts`, `packages/fez-evals/tests/summon-mentions.test.ts`

**Interfaces:**
- Produces: `STARTER_TEAM: StarterPersona[]` with `id: "drift"` and `id: "quill"` (order: drift first). Consumed by Tasks 5, 7, 13.

- [ ] **Step 1: Write the failing test**

Add to `packages/fez-evals/tests/welcome-opener.test.ts`:

```ts
import { STARTER_TEAM, teamOpenerText } from "../../fez-desktop/src/welcome-core.js";
import { summonMentions } from "../../fez-sentinel/src/index.js";

describe("starter team — fez cast names", () => {
  it("is drift (researcher) then quill (scribe)", () => {
    expect(STARTER_TEAM.map((p) => p.id)).toEqual(["drift", "quill"]);
  });
  it("summons copy addresses both by real parser rules", () => {
    // fez-acp/sentinel addressing: each @name must open a sentence.
    expect(summonMentions(teamOpenerText(STARTER_TEAM.map((p) => p.id)))).toEqual(["drift", "quill"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/fez-evals -- welcome-opener`
Expected: FAIL — `["researcher","scribe"]` ≠ `["drift","quill"]`

- [ ] **Step 3: Rename in welcome-core.ts**

Replace the two STARTER_TEAM entries (keep the interface and builder untouched):

```ts
export const STARTER_TEAM: StarterPersona[] = [
  {
    id: "drift",
    description: "search the web, find papers and specs, look up facts, verify claims",
    prompt:
      "You are @drift, a careful researcher — just passing through, always finding things. Dig into questions, compare options, check assumptions, and come back with clear, sourced answers. When a task belongs to a different agent, hand it off with an @mention and say why.",
  },
  {
    id: "quill",
    description: "write and edit — drafts, summaries, docs, tricky wording",
    prompt:
      "You are @quill, a precise, warm writer — the ink's still wet. Help with drafts, edits, summaries, and making hard things land clearly and kindly. When a task belongs to a different agent, hand it off with an @mention and say why.",
  },
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix packages/fez-evals -- welcome-opener` then the full `npm test --prefix packages/fez-evals`
Expected: PASS (if any other eval hardcodes "researcher"/"scribe", update it to the new ids — same assertion, new names)

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/welcome-core.ts packages/fez-evals/tests/welcome-opener.test.ts
git commit -m "welcome: starter team gets its fez cast names — @drift and @quill"
```

---

### Task 2: Persona builders learn `effort`; welcome-core learns #welcome

**Files:**
- Modify: `packages/fez-desktop/src/welcome-core.ts` (buildFezPersonaMd:75, buildStarterPersonaMd:114, parsePersonaBrain:124; add WELCOME_CHANNEL_ID)
- Test: `packages/fez-evals/tests/welcome-opener.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5, 6, 9, 10):
  - `export const WELCOME_CHANNEL_ID = "bootstrap-welcome"`
  - `buildFezPersonaMd(harness: string, model?: string, provider?: string, effort?: string): string`
  - `buildStarterPersonaMd(p: StarterPersona, harness: string, model?: string, provider?: string, effort?: string): string`
  - `parsePersonaBrain(md: string): { harness: string; model?: string; provider?: string; effort?: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { buildFezPersonaMd, parsePersonaBrain, WELCOME_CHANNEL_ID } from "../../fez-desktop/src/welcome-core.js";

describe("persona brain — effort", () => {
  it("round-trips harness/provider/model/effort", () => {
    const md = buildFezPersonaMd("pi", "deepseek-ai/DeepSeek-V3.2", "local-56105ece7a", "high");
    expect(parsePersonaBrain(md)).toEqual({
      harness: "pi", model: "deepseek-ai/DeepSeek-V3.2", provider: "local-56105ece7a", effort: "high",
    });
  });
  it("omits effort/model/provider lines when not chosen", () => {
    const md = buildFezPersonaMd("claude-code");
    expect(md).not.toMatch(/^(effort|model|provider):/m);
  });
  it("names the welcome channel", () => {
    expect(WELCOME_CHANNEL_ID).toBe("bootstrap-welcome");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/fez-evals -- welcome-opener`
Expected: FAIL — no `WELCOME_CHANNEL_ID` export, `effort` undefined in parse result

- [ ] **Step 3: Implement in welcome-core.ts**

```ts
export const WELCOME_CHANNEL_ID = "bootstrap-welcome";

export function buildFezPersonaMd(harness: string, model?: string, provider?: string, effort?: string): string {
  const brainLines =
    (model && provider ? `provider: ${provider}\nmodel: ${model}\n` : model ? `model: ${model}\n` : "") +
    (effort ? `effort: ${effort}\n` : "");
  return (
    `---\nharness: ${harness}\n${brainLines}aliases: [orchestrator]\n` +
    `description: your guide to fez — ask how anything works, or hand over a task and the right agent gets it\n---\n` +
    `You are @fez, the guide for this fez workspace. Answer questions about fez\n` +
    `plainly; for tasks, name the persona best suited and offer to bring it in.\n`
  );
}

export function buildStarterPersonaMd(p: StarterPersona, harness: string, model?: string, provider?: string, effort?: string): string {
  const brainLines =
    (model && provider ? `provider: ${provider}\nmodel: ${model}\n` : model ? `model: ${model}\n` : "") +
    (effort ? `effort: ${effort}\n` : "");
  return `---\nharness: ${harness}\n${brainLines}description: ${p.description}\n---\n${p.prompt}\n`;
}

export function parsePersonaBrain(md: string): { harness: string; model?: string; provider?: string; effort?: string } {
  const grab = (key: string) => md.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return { harness: grab("harness") ?? "pi", model: grab("model"), provider: grab("provider"), effort: grab("effort") };
}
```

Note the new `model`-without-`provider` form: claude-code personas carry `model:` alone (Task 4 makes fez-acp honor it via `ANTHROPIC_MODEL`).

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test --prefix packages/fez-evals`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/welcome-core.ts packages/fez-evals/tests/welcome-opener.test.ts
git commit -m "welcome-core: persona effort field + WELCOME_CHANNEL_ID"
```

---

### Task 3: Rust — provider table + `wire_provider_pi`

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (around `wire_chutes_pi`, line 648)
- Test: Rust unit tests in the same file (`#[cfg(test)]`)

**Interfaces:**
- Produces (consumed by Tasks 6, 10, and ModelPicker):
  - Tauri command `wire_provider_pi(provider: String) -> Result<String, String>` returning `{"provider":"local-<id>","models":[...]}` JSON
  - Tauri command `provider_key_present(provider: String) -> Result<bool, String>`
  - `wire_chutes_pi` kept as a delegating wrapper (existing callers keep working)
- Consumes: existing `set_skill_secret` / keychain service `fez-skill-env`.

- [ ] **Step 1: Write failing Rust unit tests**

At the bottom of lib.rs (or in the tests module if one exists):

```rust
#[cfg(test)]
mod provider_tests {
    use super::{provider_spec, local_provider_id};
    #[test]
    fn table_has_the_v1_four() {
        for p in ["chutes", "anthropic", "openai", "openrouter"] {
            assert!(provider_spec(p).is_some(), "missing provider {p}");
        }
        assert!(provider_spec("nope").is_none());
    }
    #[test]
    fn chutes_id_matches_the_legacy_constant() {
        // sha256("https://llm.chutes.ai/v1")[..10] — pinned by the existing wiring.
        assert_eq!(local_provider_id("https://llm.chutes.ai/v1"), "56105ece7a");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/fez-desktop/src-tauri/Cargo.toml provider_tests`
Expected: FAIL — `provider_spec` / `local_provider_id` not defined

- [ ] **Step 3: Implement the table and command**

```rust
struct ProviderSpec {
    /// UI id and skill-secret namespace ("chutes" → account "chutes.CHUTES_API_KEY").
    id: &'static str,
    name: &'static str,
    base_url: &'static str,
    key_name: &'static str,
    /// How the models-listing endpoint authenticates.
    auth: ProviderAuth,
}
enum ProviderAuth { Bearer, XApiKey }

fn provider_spec(id: &str) -> Option<&'static ProviderSpec> {
    const PROVIDERS: &[ProviderSpec] = &[
        ProviderSpec { id: "chutes", name: "Chutes", base_url: "https://llm.chutes.ai/v1", key_name: "CHUTES_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "anthropic", name: "Anthropic", base_url: "https://api.anthropic.com/v1", key_name: "ANTHROPIC_API_KEY", auth: ProviderAuth::XApiKey },
        ProviderSpec { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", key_name: "OPENAI_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_name: "OPENROUTER_API_KEY", auth: ProviderAuth::Bearer },
    ];
    PROVIDERS.iter().find(|p| p.id == id)
}

/// pi's local-models provider id: "local-" + sha256(baseUrl)[..10]. This fn
/// returns just the hash fragment (the `id` field in local-models.json).
fn local_provider_id(base_url: &str) -> String {
    use sha2::{Digest, Sha256};
    let hex = format!("{:x}", Sha256::digest(base_url.as_bytes()));
    hex[..10].to_string()
}

#[tauri::command]
fn provider_key_present(provider: String) -> Result<bool, String> {
    let spec = provider_spec(&provider).ok_or_else(|| format!("unknown provider {provider}"))?;
    has_skill_secret(spec.id.to_string(), spec.key_name.to_string())
}

#[tauri::command]
fn wire_provider_pi(provider: String) -> Result<String, String> {
    let spec = provider_spec(&provider).ok_or_else(|| format!("unknown provider {provider}"))?;
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let key = Command::new("security")
        .args(["find-generic-password", "-s", "fez-skill-env", "-a", &format!("{}.{}", spec.id, spec.key_name), "-w"])
        .output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("No {} key yet — add it first.", spec.name))?;

    let frag = local_provider_id(spec.base_url);
    // Same careful merge as the original wire_chutes_pi: pi owns this file.
    let cfg = std::path::Path::new(&home).join(".pi").join("agent").join("local-models.json");
    let mut endpoints: Vec<serde_json::Value> = match std::fs::read_to_string(&cfg) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| {
            format!("~/.pi/agent/local-models.json exists but isn't the JSON array pi expects — fix or remove it, then retry ({e})")
        })?,
        Err(_) => Vec::new(),
    };
    endpoints.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(frag.as_str()));
    endpoints.push(serde_json::json!({ "id": frag, "name": spec.name, "baseUrl": spec.base_url, "apiKey": key, "status": "checking" }));
    if let Some(parent) = cfg.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(&endpoints).map_err(|e| e.to_string())?;
    std::fs::write(&cfg, text + "\n").map_err(|e| format!("couldn't write pi local-models.json: {e}"))?;

    // The proof is a live model list. Anthropic's native listing wants
    // x-api-key + anthropic-version; the OpenAI-compat providers take Bearer.
    let req = ureq::get(&format!("{}/models", spec.base_url)).timeout(std::time::Duration::from_secs(30));
    let req = match spec.auth {
        ProviderAuth::Bearer => req.set("authorization", &format!("Bearer {key}")),
        ProviderAuth::XApiKey => req.set("x-api-key", &key).set("anthropic-version", "2023-06-01"),
    };
    let body = req.call().map_err(|e| format!("{} wired, but couldn't list models: {e}", spec.name))?
        .into_string().map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let models: Vec<String> = parsed.pointer("/data").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    if models.is_empty() { return Err(format!("{} returned no models", spec.name)); }
    Ok(serde_json::json!({ "provider": format!("local-{frag}"), "models": models }).to_string())
}
```

Then shrink `wire_chutes_pi` to `wire_provider_pi("chutes".into())` (keep the `#[tauri::command]` so ModelPicker/Onboarding callers keep working), add `sha2` to `src-tauri/Cargo.toml` dependencies if absent, and register `wire_provider_pi` + `provider_key_present` in the `invoke_handler` list.

- [ ] **Step 4: Run tests + typecheck**

Run: `cargo test --manifest-path packages/fez-desktop/src-tauri/Cargo.toml provider_tests` and `cargo check --manifest-path packages/fez-desktop/src-tauri/Cargo.toml`
Expected: tests PASS, check clean

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src-tauri
git commit -m "desktop: provider table — wire_provider_pi for chutes/anthropic/openai/openrouter"
```

---

### Task 4: fez-acp honors `effort` (pi) and `model` (claude-code)

**Files:**
- Modify: `src/identity/personas.ts:172` (KNOWN_EXTRA_KEYS), `packages/fez-acp/src/agent.ts:343-378` (pi settings block) and the claude-code path near it
- Test: `packages/fez-evals/tests/persona-brain-plumbing.test.ts` (create)

**Interfaces:**
- Consumes: persona `extra.effort` (`low|medium|high`) and `extra.model` written by Task 2's builders.
- Produces: `export function piThinkingLevel(effort?: string): string | undefined` in `packages/fez-acp/src/agent.ts` (exported for the eval); pi personas get `defaultThinkingLevel` in `.pi/settings.json`; claude-code personas get `process.env.ANTHROPIC_MODEL` set before the harness session opens.

- [ ] **Step 1: Write the failing test**

Create `packages/fez-evals/tests/persona-brain-plumbing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { piThinkingLevel } from "../../fez-acp/src/agent.js";
import { KNOWN_EXTRA_KEYS } from "../../../src/identity/personas.js";

describe("persona brain plumbing", () => {
  it("effort is a known persona key", () => {
    expect(KNOWN_EXTRA_KEYS).toContain("effort");
  });
  it("maps effort to pi thinking levels, rejecting junk", () => {
    expect(piThinkingLevel("low")).toBe("low");
    expect(piThinkingLevel("medium")).toBe("medium");
    expect(piThinkingLevel("high")).toBe("high");
    expect(piThinkingLevel("turbo")).toBeUndefined();
    expect(piThinkingLevel(undefined)).toBeUndefined();
  });
});
```

(If `KNOWN_EXTRA_KEYS`'s relative path differs, mirror how an existing eval imports from `src/` — check `packages/fez-evals/tests/` for a sibling import first; if none imports root `src/`, drop that assertion into a direct string check of the personas.ts source instead.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/fez-evals -- persona-brain`
Expected: FAIL — `piThinkingLevel` not exported, `effort` not in KNOWN_EXTRA_KEYS

- [ ] **Step 3: Implement**

In `src/identity/personas.ts` KNOWN_EXTRA_KEYS array, after `"model", // pi: defaultModel` add:

```ts
  "effort", // pi: defaultThinkingLevel (low|medium|high)
```

In `packages/fez-acp/src/agent.ts`, next to the pi settings block:

```ts
/** Persona effort → pi's ThinkingLevel. Junk is ignored, not guessed. */
export function piThinkingLevel(effort?: string): string | undefined {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}
```

and inside the existing block that builds `piSettings` (agent.ts:343-378):

```ts
const thinking = piThinkingLevel(persona.extra.effort);
if (thinking) piSettings.defaultThinkingLevel = thinking;
```

For claude-code, in the same persona-applying section (before the harness session is built — the spot where `persona.extra` is already in scope and the harness id is known):

```ts
// Claude Code has no per-session model param in our ACP path; the CLI
// honors ANTHROPIC_MODEL, and this process is per-persona, so process
// env is exactly persona-scoped.
if (persona.harness === "claude-code" && persona.extra.model) {
  process.env.ANTHROPIC_MODEL = persona.extra.model;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test --prefix packages/fez-evals -- persona-brain` and `npx tsc --noEmit -p packages/fez-acp` (or the repo's root `npm run check` equivalent if fez-acp has no own tsconfig — match how fez-acp is typechecked today)
Expected: PASS / clean

- [ ] **Step 5: Commit**

```bash
git add src/identity/personas.ts packages/fez-acp/src/agent.ts packages/fez-evals/tests/persona-brain-plumbing.test.ts
git commit -m "fez-acp: personas carry effort (pi thinking level) and claude model"
```

---

### Task 5: Rust — managed agents module (Buzz's shape)

**Files:**
- Create: `packages/fez-desktop/src-tauri/src/managed_agents.rs`
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (mod + invoke_handler registration + exit hook)

**Interfaces:**
- Produces Tauri commands (consumed by Tasks 6, 7, and the Playwright bridge):
  - `start_managed_agent(persona: String, owner: String, relay: String, channels: String) -> Result<(), String>` — no-op if already running or a live sentinel owns spawning
  - `stop_managed_agents() -> Result<(), String>`
  - `managed_agent_status() -> Result<String, String>` — JSON `{"<persona>": "running" | "exited"}`
- Consumes: bundled `~/.fez/bin/fez-agent`; sentinel pidfile `~/.fez/sentinel.pid`.

- [ ] **Step 1: Write failing Rust unit test**

In `managed_agents.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn env_is_complete_and_safe() {
        let env = agent_env("drift", "aabb", "ws://127.0.0.1:7777", "bootstrap-welcome");
        assert_eq!(env.get("FEZ_AGENT_PERSONA").unwrap(), "drift");
        assert_eq!(env.get("FEZ_AGENT_OWNER").unwrap(), "aabb");
        assert_eq!(env.get("FEZ_RELAY").unwrap(), "ws://127.0.0.1:7777");
        assert_eq!(env.get("FEZ_AGENT_CHANNELS").unwrap(), "bootstrap-welcome");
    }
    #[test]
    fn persona_names_are_validated() {
        assert!(validate_persona("drift").is_ok());
        assert!(validate_persona("../evil").is_err());
        assert!(validate_persona("a b").is_err());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --manifest-path packages/fez-desktop/src-tauri/Cargo.toml managed_agents`
Expected: FAIL — module/functions don't exist

- [ ] **Step 3: Implement managed_agents.rs**

```rust
//! Desktop-managed agents — Buzz's shape: the app IS the supervisor
//! while it's open. Spawns ~/.fez/bin/fez-agent per persona with the
//! same env the sentinel's agentEnvCmd builds, so an agent behaves
//! identically no matter who started it. The GUI never spawns the
//! sentinel; if a sentinel is already alive (TUI world), we defer.
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static CHILDREN: Mutex<Option<HashMap<String, Child>>> = Mutex::new(None);

pub fn validate_persona(name: &str) -> Result<(), String> {
    if !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("bad persona name: {name}"))
    }
}

pub fn agent_env(persona: &str, owner: &str, relay: &str, channels: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("FEZ_AGENT_PERSONA".into(), persona.into());
    env.insert("FEZ_AGENT_OWNER".into(), owner.into());
    env.insert("FEZ_RELAY".into(), relay.into());
    env.insert("FEZ_AGENT_CHANNELS".into(), channels.into());
    env
}

fn sentinel_alive() -> bool {
    let Ok(home) = std::env::var("HOME") else { return false };
    let pidfile = std::path::Path::new(&home).join(".fez").join("sentinel.pid");
    let Ok(pid) = std::fs::read_to_string(&pidfile) else { return false };
    let Ok(pid) = pid.trim().parse::<i32>() else { return false };
    // kill -0: process exists (unix). A stale pidfile fails this probe.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[tauri::command]
pub fn start_managed_agent(persona: String, owner: String, relay: String, channels: String) -> Result<(), String> {
    validate_persona(&persona)?;
    if sentinel_alive() {
        return Ok(()); // the TUI world owns spawning right now — never double-spawn
    }
    let mut guard = CHILDREN.lock().map_err(|e| e.to_string())?;
    let children = guard.get_or_insert_with(HashMap::new);
    if let Some(child) = children.get_mut(&persona) {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(()); // already running
        }
        children.remove(&persona);
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let bin = std::path::Path::new(&home).join(".fez").join("bin").join("fez-agent");
    if !bin.exists() {
        return Err("bundled fez-agent missing from ~/.fez/bin".to_string());
    }
    let logs = std::path::Path::new(&home).join(".fez").join("logs");
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(logs.join(format!("{persona}.desktop.log"))).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&bin)
        .envs(agent_env(&persona, &owner, &relay, &channels))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("couldn't spawn fez-agent for {persona}: {e}"))?;
    children.insert(persona, child);
    Ok(())
}

#[tauri::command]
pub fn managed_agent_status() -> Result<String, String> {
    let mut guard = CHILDREN.lock().map_err(|e| e.to_string())?;
    let children = guard.get_or_insert_with(HashMap::new);
    let mut map = serde_json::Map::new();
    for (name, child) in children.iter_mut() {
        let running = child.try_wait().map_err(|e| e.to_string())?.is_none();
        map.insert(name.clone(), serde_json::json!(if running { "running" } else { "exited" }));
    }
    Ok(serde_json::Value::Object(map).to_string())
}

#[tauri::command]
pub fn stop_managed_agents() -> Result<(), String> {
    let mut guard = CHILDREN.lock().map_err(|e| e.to_string())?;
    if let Some(children) = guard.as_mut() {
        for (_, child) in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        children.clear();
    }
    Ok(())
}
```

In lib.rs: `mod managed_agents;`, register the three commands in `invoke_handler`, add `libc` to Cargo.toml if absent, and in the app's exit path (the existing `RunEvent::Exit` / window-destroyed handler if one exists, else add `.on_window_event` on the main window builder) call `managed_agents::stop_managed_agents().ok()`. Restart-on-crash is deliberately NOT in v1: `ensureStarterTeam` re-invokes `start_managed_agent` on each run (idempotent), and fez-acp reports failed turns in-channel — a crash loop supervisor is YAGNI until observed.

- [ ] **Step 4: Run tests + cargo check**

Run: `cargo test --manifest-path packages/fez-desktop/src-tauri/Cargo.toml managed_agents && cargo check --manifest-path packages/fez-desktop/src-tauri/Cargo.toml`
Expected: PASS / clean

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src-tauri
git commit -m "desktop: managed agents — the app supervises its personas, no sentinel in the GUI"
```

---

### Task 6: Bootstrap #welcome + rewire ensureWelcome (roster, spawn, readiness)

**Files:**
- Modify: `packages/fez-desktop/src/boot-workspace.ts`, `packages/fez-desktop/src/welcome.ts`, `packages/fez-desktop/src/App.tsx:192-194` (drop ensure_agent_runner), `packages/fez-desktop/src/App.tsx:1851` (mention hint channel check)
- Test: `packages/fez-evals/tests/cold-start-bootstrap.test.ts`

**Interfaces:**
- Consumes: `WELCOME_CHANNEL_ID`, `STARTER_TEAM`, builders (Tasks 1-2); `start_managed_agent`, `managed_agent_status`, `provider_key_present` (Tasks 3, 5).
- Produces: `ensureOwnerBootstrap` also creates `bootstrap-welcome` and lands scope there on a fresh workspace; `ensureWelcome(client)` posts only into #welcome, checks markers in BOTH channels, rosters+attests+spawns the trio.

- [ ] **Step 1: Extend the failing eval**

In `packages/fez-evals/tests/cold-start-bootstrap.test.ts` (it already boots `ensureOwnerBootstrap` against a real spawned relay — follow its existing setup), add:

```ts
it("creates #welcome and lands scope in it", async () => {
  // ...existing spawnRelay + client setup from this file...
  const ok = await ensureOwnerBootstrap(client);
  expect(ok).toBe(true);
  expect(client.state.workspace.channels.has("bootstrap-welcome")).toBe(true);
  expect(client.state.workspace.channels.get("bootstrap-welcome")?.name).toBe("welcome");
  expect(client.state.scope?.channelId).toBe("bootstrap-welcome");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/fez-evals -- cold-start-bootstrap`
Expected: FAIL — no bootstrap-welcome channel

- [ ] **Step 3: Implement boot-workspace.ts**

```ts
import type { FezClient } from "@fezchat/client";
import { WELCOME_CHANNEL_ID } from "./welcome-core";

export async function ensureOwnerBootstrap(client: FezClient): Promise<boolean> {
  if (!client.state.isOwner(client.pubkey)) return false;
  if (client.state.workspace.channels.size === 0) {
    await client.ensureChannel({ name: "general", id: "bootstrap-general" }).catch(() => {});
    // The room the welcome choreography owns. visibility "closed" is
    // serialized-but-unenforced today (workspace roster is the real
    // gate); in a fresh solo workspace that's truthful in effect.
    await client.ensureChannel({ name: "welcome", id: WELCOME_CHANNEL_ID, visibility: "closed" }).catch(() => {});
  }
  const ok = client.state.workspace.channels.size > 0;
  if (ok && !client.state.scope) {
    // Land in #welcome (the guided room), else general, else anything.
    const channelId = client.state.workspace.channels.has(WELCOME_CHANNEL_ID)
      ? WELCOME_CHANNEL_ID
      : client.state.workspace.channels.has("bootstrap-general")
        ? "bootstrap-general"
        : [...client.state.workspace.channels.keys()][0];
    client.setScope(channelId);
  }
  return ok;
}
```

- [ ] **Step 4: Run eval, verify pass**

Run: `npm test --prefix packages/fez-evals -- cold-start-bootstrap`
Expected: PASS (including the pre-existing cases — a workspace that already has channels gets NO new #welcome, which is the migration story)

- [ ] **Step 5: Rewire welcome.ts**

Changes, in place (the file's existing structure survives):

```ts
import { WELCOME_CHANNEL_ID /* + existing imports */ } from "./welcome-core";

const PROVIDER_IDS = ["chutes", "anthropic", "openai", "openrouter"];

export async function readiness(): Promise<Readiness> {
  const harnesses = await detectHarnesses();
  let claudeReady = false;
  try {
    const c = JSON.parse(await invoke<string>("claude_brain_status")) as {
      installed: boolean; authed: boolean; adapterReady: boolean;
    };
    claudeReady = c.installed && c.authed && c.adapterReady;
  } catch { claudeReady = false; }
  // Any configured provider counts — the Chutes-only gate was the bug
  // that kept the team from ever spawning.
  let piKeyed = false;
  for (const p of PROVIDER_IDS) {
    if (await invoke<boolean>("provider_key_present", { provider: p }).catch(() => false)) { piKeyed = true; break; }
  }
  // runner: the app supervises its own agents now — spawn is ours to do,
  // so "someone is listening" is simply "we are able to spawn".
  return { authed: claudeReady || (!!harnesses["pi"] && piKeyed), runner: true };
}
```

In `ensureWelcome`:
- Target channel: `const channel = client.state.workspace.channels.get(WELCOME_CHANNEL_ID) ?? client.state.workspace.channels.get("bootstrap-general");` — post into `#welcome` when it exists; an old install without it keeps its general-channel history honored.
- Marker idempotency across both rooms: query both and merge before any publish:

```ts
const welcomeEvents = await w.existing(WELCOME_CHANNEL_ID).catch(() => []);
const generalEvents = await w.existing("bootstrap-general").catch(() => []);
const existing = [...welcomeEvents, ...generalEvents];
```

Use `existing` for every `findMarked` check, but keep all `ensureMarkedMessage` publishes aimed at `channel.id` — add an `alreadyMarked` fast path: wrap `ensureMarkedMessage` calls as `if (!findMarked(existing, MARKER)) await ensureMarkedMessage(w, channel.id, ...)` (ensureMarkedMessage re-checks its own channel; the wrap adds the cross-channel check).
- In `ensureStarterTeam`, before the summons: give every teammate the @fez treatment plus a spawn:

```ts
const owner = client.pubkey;
const relay = relaySet()[0];
for (const p of STARTER_TEAM) {
  // Same custody as @fez: keychain fez-keys / agent:<name> — the key the
  // spawned fez-agent will load is the key we roster here.
  let hex: string;
  try {
    hex = await invoke<string>("get_identity", { account: `agent:${p.id}` });
  } catch {
    hex = bytesToHex(generateSecretKey());
    await invoke("set_identity", { hex, account: `agent:${p.id}` });
  }
  const pk = getPublicKey(hexToBytes(hex));
  if (!client.state.isMember(pk)) {
    await client.invite(pk, "bot").catch(() => {});
    await client.attestAgent(pk).catch(() => {});
  }
  await invoke("start_managed_agent", { persona: p.id, owner, relay, channels: channelId }).catch(() => {});
}
```

- Also spawn @fez itself the same way (persona "fez") right after its existing invite/attest block in `ensureWelcome` — the guide should answer real mentions, not only post scripted lines.
- Delete the `runner` polling loop (the pidfile sleep-poll at welcome.ts:88-93) — `readiness().runner` is now constant-true.

In `App.tsx`: remove the `await invoke("ensure_agent_runner").catch(() => {});` line (192-193); change line 1851's mention-hint gate from `channelId === "bootstrap-general"` to `(channelId === "bootstrap-general" || channelId === "bootstrap-welcome")`.

- [ ] **Step 6: Typecheck + full evals**

Run: `npm run check --prefix packages/fez-desktop && npm test --prefix packages/fez-evals`
Expected: clean / PASS (update `welcome-opener.test.ts` fixtures if they stub `runner_status` — the probe is gone)

- [ ] **Step 7: Commit**

```bash
git add packages/fez-desktop/src packages/fez-evals/tests
git commit -m "welcome: #welcome channel, trio rostered+attested+desktop-spawned, provider-wide readiness"
```

---

### Task 7: Onboarding step skeleton — new order, name moves out

**Files:**
- Modify: `packages/fez-desktop/src/Onboarding.tsx`
- Test: Playwright covers this (Task 10-12); this task keeps `npm run check` green and the app bootable.

**Interfaces:**
- Produces the step machine consumed by Tasks 8-9 and the Playwright suite:
  - `type Step = "welcome" | "invite" | "pairing" | "restore" | "reconnect" | "harness" | "defaults" | "community" | "profile" | "team" | "done"`
  - Forward order: welcome → harness → defaults → community → profile → team → done. `next(step)`/`back(step)` helpers exported for tests: `export function nextStep(s: Step): Step` / `export function prevStep(s: Step): Step`.
  - Shared wizard state lifted to the top component: `{ name, setName, brain: { harness?: "claude-code" | "pi"; provider?: string; model?: string; effort?: string }, setBrain }`.

- [ ] **Step 1: Write the failing eval for the step machine**

Add `packages/fez-evals/tests/onboarding-steps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextStep, prevStep } from "../../fez-desktop/src/Onboarding.js";

describe("onboarding step order", () => {
  it("walks the locked order forward", () => {
    const walk = ["welcome", "harness", "defaults", "community", "profile", "team", "done"];
    for (let i = 0; i < walk.length - 1; i++) expect(nextStep(walk[i] as never)).toBe(walk[i + 1]);
  });
  it("back retraces it", () => {
    expect(prevStep("defaults" as never)).toBe("harness");
    expect(prevStep("team" as never)).toBe("profile");
    expect(prevStep("welcome" as never)).toBe("welcome");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix packages/fez-evals -- onboarding-steps`
Expected: FAIL — no exports

- [ ] **Step 3: Restructure Onboarding.tsx**

- Add the exports:

```ts
const ORDER: Step[] = ["welcome", "harness", "defaults", "community", "profile", "team", "done"];
export function nextStep(s: Step): Step {
  const i = ORDER.indexOf(s);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : s;
}
export function prevStep(s: Step): Step {
  const i = ORDER.indexOf(s);
  return i > 0 ? ORDER[i - 1] : s;
}
```

- Welcome card: remove the name `<input>` (name now belongs to the profile step; keep `const [name, setName]` state at the top level). Primary button label becomes plain `"get started"`. `start()` loses the name-dependent bits: workspace naming moves to the community step (Task 9), the kind-0 publish moves to the profile step (Task 9). What remains in `start()`: identity creation (`set_identity`) exactly as today, then `setStep("harness")`.
- Side doors (invite/pairing/restore/reconnect) keep their current components untouched; pairing/restore's `onPaired`/`onRestored` continue to `setStep("reconnect")`, and `ReconnectStep`'s `onNext` becomes `() => setStep("harness")` — a second device also picks its local brain.
- Every main-flow step renders a `back` secondary button calling `setStep(prevStep(step))` except `welcome` and `done`.
- Placeholder bodies for `harness | defaults | community | profile | team` in this task: render the step name + next/back wired through `nextStep`/`prevStep` (filled in by Tasks 8-9). This keeps the app walkable end-to-end at every commit — `done` keeps today's content until Task 9 moves the backup-key reveal to `team`.

- [ ] **Step 4: Run eval + typecheck**

Run: `npm test --prefix packages/fez-evals -- onboarding-steps && npm run check --prefix packages/fez-desktop`
Expected: PASS / clean

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/Onboarding.tsx packages/fez-evals/tests/onboarding-steps.test.ts
git commit -m "onboarding: buzz step order — welcome, harness, defaults, community, profile, team"
```

---

### Task 8: Harness page + defaults page

**Files:**
- Modify: `packages/fez-desktop/src/Onboarding.tsx` (replace BrainStep with HarnessStep + DefaultsStep), `packages/fez-desktop/src/App.css` (a few additions to the ob- family)
- Test: Playwright (Task 11); `npm run check` gates this task.

**Interfaces:**
- Consumes: `claude_brain_status`, `ensure_claude_adapter`, `detect_harnesses` (existing), `wire_provider_pi`, `provider_key_present` (Task 3); wizard state from Task 7.
- Produces: `HarnessStep({ claude, onProbe, onSetup, onNext, onBack })` and `DefaultsStep({ claudeReady, brain, setBrain, onNext, onBack })`; the four-provider UI table `export const PROVIDERS = [{ id: "chutes", label: "Chutes", hint: "decentralized GPUs — chutes.ai" }, { id: "anthropic", label: "Anthropic", hint: "api key from console.anthropic.com" }, { id: "openai", label: "OpenAI", hint: "api key from platform.openai.com" }, { id: "openrouter", label: "OpenRouter", hint: "one key, many models — openrouter.ai" }]`.

- [ ] **Step 1: HarnessStep — two cards, detection states**

Buzz's grid, fez-sized. Reuses the existing `ClaudeBrain` probe state and all of BrainStep's Claude click-handling (install page / sign-in hint / one-time `ensure_claude_adapter` / READY), presented as an informational card — no selection here:

```tsx
function HarnessStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [claude, setClaude] = useState<ClaudeBrain>();
  const [settingUp, setSettingUp] = useState(false);
  const [error, setError] = useState<string>();
  const probeClaude = () =>
    invoke<string>("claude_brain_status")
      .then((json) => setClaude(JSON.parse(json) as ClaudeBrain))
      .catch(() => setClaude({ installed: false, authed: false, adapterReady: false }));
  useEffect(() => { void probeClaude(); }, []);

  return (
    <>
      <h2>Your agent harnesses</h2>
      <p className="ob-lede">fez checked this machine. Fez ships with the app; Claude Code is detected if you have it.</p>
      <div className="ob-brains">
        <div className="ob-brain">
          <span className="ob-brain-name">Fez</span>
          <span className="ob-brain-pill ready">READY</span>
          <span className="ob-brain-hint">ships with fez — bring a model key on the next page</span>
        </div>
        {/* Claude card: same five states as the old BrainStep (CHECKING…/
            INSTALL/SIGN IN/SET UP/READY), same handlers — the JSX moves
            here verbatim with setChoice() calls removed; SET UP still
            runs ensure_claude_adapter. */}
      </div>
      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" onClick={onNext}>continue</button>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}
```

- [ ] **Step 2: DefaultsStep — harness dropdown, then per-harness config**

```tsx
export const PROVIDERS = [
  { id: "chutes", label: "Chutes", hint: "decentralized GPUs — chutes.ai" },
  { id: "anthropic", label: "Anthropic", hint: "api key from console.anthropic.com" },
  { id: "openai", label: "OpenAI", hint: "api key from platform.openai.com" },
  { id: "openrouter", label: "OpenRouter", hint: "one key, many models — openrouter.ai" },
];
export const CLAUDE_MODELS = ["default", "opus", "sonnet", "haiku"];
export const EFFORTS = ["low", "medium", "high"];

function DefaultsStep({ claudeReady, brain, setBrain, onNext, onBack }: {
  claudeReady: boolean;
  brain: Brain; setBrain: (b: Brain) => void;
  onNext: () => void; onBack: () => void;
}) {
  const [providerKey, setProviderKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const verify = async () => {
    if (!brain.providerId) return;
    setBusy(true); setError(undefined);
    try {
      if (providerKey.trim()) {
        const spec = { chutes: "CHUTES_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
        await invoke("set_skill_secret", { skill: brain.providerId, key: spec[brain.providerId as keyof typeof spec], value: providerKey.trim() });
      }
      const json = await invoke<string>("wire_provider_pi", { provider: brain.providerId });
      const r = JSON.parse(json) as { provider: string; models: string[] };
      setModels(r.models);
      setBrain({ ...brain, harness: "pi", provider: r.provider, model: r.models[0], effort: brain.effort ?? "medium" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <>
      <h2>Configure your defaults</h2>
      <p className="ob-lede">Your agents run on this unless you give one its own setup — changeable any time in Settings.</p>
      <label className="ob-label">default harness</label>
      <select className="ob-input" value={brain.harness ?? ""} onChange={(e) => setBrain({ ...brain, harness: e.target.value as Brain["harness"], provider: undefined, model: undefined })}>
        <option value="">choose…</option>
        <option value="pi">Fez</option>
        {claudeReady && <option value="claude-code">Claude Code</option>}
      </select>

      {brain.harness === "claude-code" && (
        <>
          <label className="ob-label">model</label>
          <select className="ob-input" value={brain.model ?? "default"} onChange={(e) => setBrain({ ...brain, model: e.target.value })}>
            {CLAUDE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="ob-brain-hint">uses your Claude subscription</span>
        </>
      )}

      {brain.harness === "pi" && (
        <>
          <label className="ob-label">provider</label>
          <select className="ob-input" value={brain.providerId ?? ""} onChange={(e) => { setModels([]); setBrain({ ...brain, providerId: e.target.value, provider: undefined, model: undefined }); }}>
            <option value="">choose…</option>
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {brain.providerId && models.length === 0 && (
            <div className="ob-brain-auth">
              <input className="ob-input" type="password" placeholder={`${PROVIDERS.find((p) => p.id === brain.providerId)?.label} API key`} value={providerKey}
                spellCheck={false} onChange={(e) => setProviderKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy) void verify(); }} />
              <button className="ob-secondary" disabled={busy} onClick={() => void verify()}>{busy ? "checking…" : "verify"}</button>
              <span className="ob-brain-hint">{PROVIDERS.find((p) => p.id === brain.providerId)?.hint}</span>
            </div>
          )}
          {models.length > 0 && (
            <>
              <label className="ob-label">model</label>
              <select className="ob-input" value={brain.model ?? ""} onChange={(e) => setBrain({ ...brain, model: e.target.value })}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <label className="ob-label">effort</label>
              <select className="ob-input" value={brain.effort ?? "medium"} onChange={(e) => setBrain({ ...brain, effort: e.target.value })}>
                {EFFORTS.map((e2) => <option key={e2} value={e2}>{e2}</option>)}
              </select>
            </>
          )}
        </>
      )}

      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" disabled={busy || (brain.harness === "pi" && !brain.model)} onClick={onNext}>
        {brain.harness === "pi" && brain.model ? `continue with ${brain.model}` : brain.harness === "claude-code" ? "continue with Claude Code" : "continue"}
      </button>
      <div className="ob-alts"><button className="ob-link" onClick={onNext}>skip for now</button></div>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}
```

`Brain` (in Onboarding.tsx): `{ harness?: "pi" | "claude-code"; providerId?: string; provider?: string; model?: string; effort?: string }`. The persona write happens ONCE, on wizard completion (Task 9's finish), not here: `buildFezPersonaMd(brain.harness ?? (claudeReady ? "claude-code" : "pi"), brain.model === "default" ? undefined : brain.model, brain.provider, brain.effort)`. Add `.ob-label` to App.css: `.ob-label { font-size: 12px; opacity: 0.7; margin: 10px 0 4px; display: block; text-align: left; }`. Verification failures render inline and never advance — the existing "no soft-lock" rule holds via skip.

- [ ] **Step 3: Delete BrainStep + the old "brain" step id; typecheck**

Remove `BrainStep`, `CHUTES_PROVIDER`, and the `verifyChutes` copy from Onboarding.tsx (their logic now lives in DefaultsStep via `wire_provider_pi`).
Run: `npm run check --prefix packages/fez-desktop`
Expected: clean

- [ ] **Step 4: Manual smoke in dev**

Run: `npm run dev --prefix packages/fez-desktop` — walk welcome → harness → defaults in the browser (Tauri invokes fail in plain vite; the pages must render and navigate anyway, errors surfacing as their inline states, not crashes).
Expected: all three pages render; back/skip navigate

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/Onboarding.tsx packages/fez-desktop/src/App.css
git commit -m "onboarding: harness detection page + defaults page (provider/model/effort)"
```

---

### Task 9: Community, profile, and team pages + finish wiring

**Files:**
- Modify: `packages/fez-desktop/src/Onboarding.tsx`
- Test: Playwright (Task 11-12); `npm run check` gates.

**Interfaces:**
- Consumes: existing `InviteStep`, `ReconnectStep`, `ensure_local_relay`, `write_persona`, sprites (`packages/fez-desktop/src/sprites.ts` — `fez`, `drift`, `quill` entries) and the pixel-sprite renderer (`packages/fez-desktop/src/pixel-sprite.tsx` — use the same component/props `Avatar.tsx` uses; read that file for the exact import).
- Produces: `CommunityStep`, `ProfileStep`, `TeamStep`; a single `finishWizard()` that writes personas and completes.

- [ ] **Step 1: CommunityStep — three doors**

```tsx
function CommunityStep({ onJoin, onReconnect, onCreated, onBack }: {
  onJoin: () => void; onReconnect: () => void; onCreated: () => void; onBack: () => void;
}) {
  return (
    <>
      <h2>Join or create a community</h2>
      <p className="ob-lede">Join with an invite, create your own, or reconnect one you already have.</p>
      <div className="ob-brains">
        <button className="ob-brain" onClick={onJoin}><span className="ob-brain-name">Join a community</span><span className="ob-brain-hint">paste an invite code or community URL</span></button>
        <button className="ob-brain" onClick={onCreated}><span className="ob-brain-name">Create a community</span><span className="ob-brain-hint">this machine becomes your workspace</span></button>
        <button className="ob-brain" onClick={onReconnect}><span className="ob-brain-name">I already have a community</span><span className="ob-brain-hint">your key is your membership — add its relay</span></button>
      </div>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}
```

Wiring in the parent: `onJoin` → `setStep("invite")` (InviteStep's accept now returns to `setStep("community")` with the ✓ relay noted, then continue advances); `onReconnect` → `setStep("reconnect")` (its onNext → `setStep("profile")`); `onCreated` → run the local-relay claim that currently lives in `start()`:

```ts
const createWorkspace = async () => {
  setBusy(true); setError(undefined);
  try {
    if (!localStorage.getItem("fez-pending-invite")) {
      const url = await invoke<string>("ensure_local_relay", {
        owner: getPublicKey(hexToBytes(keyHex!)),
        name: "your workspace",
      });
      setRelayUrl(url); setRelays(url);
    }
    setStep("profile");
  } catch (err) { setError(String(err)); } finally { setBusy(false); }
};
```

(`keyHex` is set by `start()` on leaving welcome — every path through community has an identity. Add `hexToBytes` to the existing nostr imports.)

- [ ] **Step 2: ProfileStep — name + optional avatar**

```tsx
function ProfileStep({ name, setName, onNext, onBack }: {
  name: string; setName: (n: string) => void; onNext: (avatarDataUrl?: string) => void; onBack: () => void;
}) {
  const [avatar, setAvatar] = useState<string>();
  const [error, setError] = useState<string>();
  const pick = (file?: File) => {
    if (!file) return;
    if (file.size > 256 * 1024) { setError("that image is over 256KB — pick a smaller one, or skip (you get a generated sprite)"); return; }
    const reader = new FileReader();
    reader.onload = () => { setError(undefined); setAvatar(String(reader.result)); };
    reader.readAsDataURL(file);
  };
  return (
    <>
      <h2>Build your profile</h2>
      <p className="ob-lede">A name and (optionally) a face. Skip the picture and you get your generated sprite — every key has one.</p>
      <label className="ob-avatar-pick">
        {avatar ? <img className="ob-avatar-img" src={avatar} alt="your avatar" /> : <span className="ob-avatar-plus">+</span>}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      <input className="ob-input" value={name} autoFocus spellCheck={false} placeholder="your name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onNext(avatar); }} />
      {error && <p className="ob-error">{error}</p>}
      <button className="ob-primary" disabled={!name.trim()} onClick={() => onNext(avatar)}>continue</button>
      <div className="ob-alts"><button className="ob-link" onClick={() => onNext(avatar)}>skip for now</button></div>
      <button className="ob-secondary" onClick={onBack}>back</button>
    </>
  );
}
```

Parent `onNext(avatar)`: `localStorage.setItem("fez-name", name.trim())`, then the best-effort kind-0 publish moved from `start()` — content now `JSON.stringify({ name: name.trim(), ...(avatar ? { picture: avatar } : {}) })` (same BrowserWire + rustSigner pattern, same try/catch-and-move-on), then `setStep("team")`. App.css: `.ob-avatar-pick { width: 96px; height: 96px; border-radius: 50%; background: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: center; margin: 12px auto; cursor: pointer; overflow: hidden; } .ob-avatar-img { width: 100%; height: 100%; object-fit: cover; } .ob-avatar-plus { font-size: 28px; opacity: 0.6; }`.

- [ ] **Step 3: TeamStep + finishWizard**

```tsx
function TeamStep({ keyHex, onFinish }: { keyHex?: string; onFinish: () => void }) {
  const [showBackup, setShowBackup] = useState(false);
  return (
    <>
      <h2>Meet your starter team</h2>
      <p className="ob-lede">fez brings agents into the same room. These three will help you get started.</p>
      <div className="ob-team">
        {(["fez", "drift", "quill"] as const).map((id) => (
          <figure key={id} className="ob-team-member">
            {/* Render SPRITES[id] with the same component Avatar.tsx uses. */}
            <PixelSprite sprite={SPRITES[id]} lit />
            <figcaption>{id.toUpperCase()}</figcaption>
          </figure>
        ))}
      </div>
      {keyHex && (
        <div className="ob-backup">
          {!showBackup ? (
            <button className="ob-secondary" onClick={() => setShowBackup(true)}>reveal backup key (write it somewhere safe)</button>
          ) : (
            <code className="ob-key" onClick={() => void navigator.clipboard.writeText(keyHex)} title="click to copy">{keyHex}</code>
          )}
        </div>
      )}
      <button className="ob-primary" onClick={onFinish}>take me to fez</button>
    </>
  );
}
```

(Adjust `PixelSprite` name/props to whatever `packages/fez-desktop/src/pixel-sprite.tsx` actually exports — read it first; `SPRITES` is `packages/fez-desktop/src/sprites.ts`.) App.css: `.ob-team { display: flex; gap: 28px; justify-content: center; margin: 22px 0; } .ob-team-member figcaption { font-size: 11px; letter-spacing: 2px; margin-top: 8px; opacity: 0.7; text-align: center; }`.

`finishWizard` (parent; TeamStep's `onFinish`):

```ts
const finishWizard = async () => {
  try {
    const harness = brain.harness ?? "pi"; // skipped defaults → honest not-ready opener covers it
    const model = brain.model === "default" ? undefined : brain.model;
    await invoke("write_persona", { name: "fez", content: buildFezPersonaMd(harness, model, brain.provider, brain.effort) });
    for (const p of STARTER_TEAM) {
      await invoke("write_persona", { name: p.id, content: buildStarterPersonaMd(p, harness, model, brain.provider, brain.effort) }).catch(() => {});
    }
  } catch { /* welcome.ts's fallback persona still lands */ }
  onComplete(relayUrl);
};
```

Imports from welcome-core: `buildFezPersonaMd, buildStarterPersonaMd, STARTER_TEAM`. Delete the old `done` step content (its backup reveal now lives in TeamStep; `done` drops out of ORDER — update Task 7's ORDER/test to end at `team`).

- [ ] **Step 4: Typecheck + dev smoke**

Run: `npm run check --prefix packages/fez-desktop`, then `npm run dev` — walk the whole wizard in the browser; every page renders and navigates.
Expected: clean; full walk possible

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src
git commit -m "onboarding: community doors, profile page, meet-your-team — full buzz walk"
```

---

### Task 10: Playwright scaffold + mock native bridge

**Files:**
- Create: `packages/fez-desktop/playwright.config.ts`, `packages/fez-desktop/tests/e2e/helpers/bridge.ts`
- Modify: `packages/fez-desktop/package.json` (devDep `@playwright/test`, scripts)

**Interfaces:**
- Produces (consumed by Tasks 11-13): `installMockBridge(page, overrides?: Partial<Record<string, (args: any) => unknown>>)` — defines `window.__TAURI_INTERNALS__` before app load; command handlers default to a fresh-machine fixture and are overridable per test.

- [ ] **Step 1: Install + config**

```bash
npm i -D @playwright/test --prefix packages/fez-desktop
npx playwright install chromium
```

`packages/fez-desktop/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

package.json scripts: `"test:e2e": "playwright test"`.

- [ ] **Step 2: The mock bridge**

`tests/e2e/helpers/bridge.ts` — Tauri v2's `invoke` calls `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`; plugins also use `transformCallback`. Defaults model a fresh machine ready for the happy path:

```ts
import type { Page } from "@playwright/test";

export type Handlers = Record<string, (args: Record<string, unknown>) => unknown>;

const FRESH_MACHINE: Handlers = {
  get_identity: () => { throw "could not be found"; }, // no identity yet → onboarding
  set_identity: () => null,
  detect_harnesses: () => JSON.stringify({ "claude-code": false, pi: true }),
  claude_brain_status: () => JSON.stringify({ installed: false, authed: false, adapterReady: false }),
  ensure_claude_adapter: () => "",
  set_skill_secret: () => null,
  has_skill_secret: () => false,
  provider_key_present: () => false,
  wire_provider_pi: () => JSON.stringify({ provider: "local-56105ece7a", models: ["mock/model-a", "mock/model-b"] }),
  wire_chutes_pi: () => JSON.stringify({ provider: "local-56105ece7a", models: ["mock/model-a"] }),
  ensure_local_relay: () => "ws://127.0.0.1:7777",
  write_persona: () => "",
  read_persona: () => { throw "no persona"; },
  start_managed_agent: () => null,
  stop_managed_agents: () => null,
  managed_agent_status: () => JSON.stringify({}),
  runner_status: () => true,
  ensure_agent_runner: () => null,
  plugin_notification_is_permission_granted: () => true,
};

export async function installMockBridge(page: Page, overrides: Handlers = {}) {
  const calls: { cmd: string; args: unknown }[] = [];
  await page.exposeFunction("__fezBridgeRecord", (cmd: string, args: unknown) => { calls.push({ cmd, args }); });
  // Handlers can't cross the page boundary as functions — serialize the
  // override RESULTS instead: each override becomes {value} or {error}.
  const table: Record<string, { value?: unknown; error?: string; isError?: boolean }> = {};
  for (const [cmd, fn] of Object.entries({ ...FRESH_MACHINE, ...overrides })) {
    try { table[cmd] = { value: fn({}) }; } catch (e) { table[cmd] = { error: String(e), isError: true }; }
  }
  await page.addInitScript((t) => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => {
        (window as any).__fezBridgeRecord?.(cmd, args);
        const entry = (t as any)[cmd];
        if (!entry) return Promise.reject(`mock bridge: unhandled command ${cmd}`);
        return entry.isError ? Promise.reject(entry.error) : Promise.resolve(entry.value);
      },
      transformCallback: (cb: unknown) => cb,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
  }, table);
  return { calls };
}
```

(If a page needs a stateful handler — e.g. `claude_brain_status` flipping after "check again" — pass a second `installMockBridge` call via `page.reload()` with new overrides; keep the bridge dumb.)

- [ ] **Step 3: Smoke spec proving the bridge boots the wizard**

`tests/e2e/smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("fresh machine lands on onboarding", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByText("Communities for you and your agents", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /get started/i })).toBeVisible();
});
```

- [ ] **Step 4: Run it**

Run: `npm run test:e2e --prefix packages/fez-desktop -- smoke`
Expected: PASS. If boot doesn't reach onboarding, fix the bridge default that's blocking (the boot path calls `get_identity` first — the thrown "could not be found" string must match what `App.tsx` treats as no-identity; read `App.tsx`'s boot classification and mirror its expected error text exactly).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/playwright.config.ts packages/fez-desktop/tests packages/fez-desktop/package.json packages/fez-desktop/package-lock.json
git commit -m "desktop: playwright scaffold + mock tauri bridge — the wizard is GUI-testable"
```

---

### Task 11: Playwright — wizard walk, harness states, defaults verify

**Files:**
- Create: `packages/fez-desktop/tests/e2e/onboarding-walk.spec.ts`, `packages/fez-desktop/tests/e2e/onboarding-defaults.spec.ts`

**Interfaces:**
- Consumes: `installMockBridge` (Task 10), the wizard from Tasks 7-9.

- [ ] **Step 1: The full walk spec**

`onboarding-walk.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("full happy path: welcome → harness → defaults → community(create) → profile → team", async ({ page }) => {
  const bridge = await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();

  await expect(page.getByText("Your agent harnesses")).toBeVisible();
  await expect(page.getByText("READY")).toBeVisible(); // the Fez card
  await page.getByRole("button", { name: /^continue$/i }).click();

  await expect(page.getByText("Configure your defaults")).toBeVisible();
  await page.locator("select").first().selectOption("pi");
  await page.locator("select").nth(1).selectOption("chutes");
  await page.getByPlaceholder(/api key/i).fill("test-key-123");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.locator("select")).toHaveCount(4); // harness, provider, model, effort
  await page.getByRole("button", { name: /continue with mock\/model-a/i }).click();

  await page.getByRole("button", { name: /create a community/i }).click();

  await expect(page.getByText("Build your profile")).toBeVisible();
  await page.getByPlaceholder("your name").fill("Doug");
  await page.getByRole("button", { name: /^continue$/i }).click();

  await expect(page.getByText("Meet your starter team")).toBeVisible();
  for (const n of ["FEZ", "DRIFT", "QUILL"]) await expect(page.getByText(n)).toBeVisible();
  await page.getByRole("button", { name: /take me to fez/i }).click();

  // The wizard's contract with the backend, asserted through the bridge:
  const personas = bridge.calls.filter((c) => c.cmd === "write_persona").map((c) => (c.args as any).name);
  expect(personas).toEqual(expect.arrayContaining(["fez", "drift", "quill"]));
  const fezMd = (bridge.calls.find((c) => c.cmd === "write_persona" && (c.args as any).name === "fez")!.args as any).content as string;
  expect(fezMd).toContain("harness: pi");
  expect(fezMd).toContain("model: mock/model-a");
  expect(fezMd).toContain("effort: medium");
});

test("back retraces from every step; skips never dead-end", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click(); // → defaults
  await page.getByRole("button", { name: /^back$/i }).click(); // → harness
  await expect(page.getByText("Your agent harnesses")).toBeVisible();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click(); // defaults skipped
  await page.getByRole("button", { name: /create a community/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click(); // profile skipped
  await expect(page.getByText("Meet your starter team")).toBeVisible();
});
```

- [ ] **Step 2: Harness states + verify failure spec**

`onboarding-defaults.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

const CLAUDE_READY = { claude_brain_status: () => JSON.stringify({ installed: true, authed: true, adapterReady: true }) };

test("claude READY shows on the harness page and unlocks the harness dropdown", async ({ page }) => {
  await installMockBridge(page, CLAUDE_READY);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByText("signed in — uses your Claude subscription")).toBeVisible();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.locator("select").first().selectOption("claude-code");
  await expect(page.getByText("uses your Claude subscription")).toBeVisible();
});

test("claude SIGN IN state renders the login hint", async ({ page }) => {
  await installMockBridge(page, { claude_brain_status: () => JSON.stringify({ installed: true, authed: false, adapterReady: false }) });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByText(/claude \/login/i)).toBeVisible();
});

test("a bad provider key fails inline and does not advance", async ({ page }) => {
  await installMockBridge(page, { wire_provider_pi: () => { throw "OpenAI wired, but couldn't list models: 401"; } });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.locator("select").first().selectOption("pi");
  await page.locator("select").nth(1).selectOption("openai");
  await page.getByPlaceholder(/api key/i).fill("sk-garbage");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByText(/couldn't list models/i)).toBeVisible();
  await expect(page.getByText("Configure your defaults")).toBeVisible(); // still here
});
```

- [ ] **Step 3: Run and stabilize**

Run: `npm run test:e2e --prefix packages/fez-desktop`
Expected: PASS. Selector drift between plan and implementation is fixed by adjusting the SPEC's selectors to the real accessible names — never by adding test ids the user-visible copy already provides.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/tests
git commit -m "e2e(gui): wizard walk, harness states, provider verify — click-by-click"
```

---

### Task 12: Playwright — community doors, profile, side doors

**Files:**
- Create: `packages/fez-desktop/tests/e2e/onboarding-community.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

async function toCommunity(page) {
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click();
}

test("join door accepts a fez-join code and returns", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  await page.getByPlaceholder(/fez-join/i).fill("fez-join:wss://relay.example#abc123-def");
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText(/wss:\/\/relay\.example/)).toBeVisible();
});

test("join door rejects garbage with the honest error", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /join a community/i }).click();
  await page.getByPlaceholder(/fez-join/i).fill("not-an-invite");
  await page.getByRole("button", { name: /accept invite/i }).click();
  await expect(page.getByText(/doesn't look like an invite/i)).toBeVisible();
});

test("reconnect door adds a relay and continues to profile", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /already have a community/i }).click();
  await page.getByPlaceholder(/wss:\/\//).fill("wss://team.example");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText("✓ wss://team.example")).toBeVisible();
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByText("Build your profile")).toBeVisible();
});

test("create door claims the local relay then reaches profile", async ({ page }) => {
  const bridge = await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /create a community/i }).click();
  await expect(page.getByText("Build your profile")).toBeVisible();
  expect(bridge.calls.some((c) => c.cmd === "ensure_local_relay")).toBe(true);
});

test("avatar over 256KB is refused with the sprite consolation", async ({ page }) => {
  await installMockBridge(page);
  await toCommunity(page);
  await page.getByRole("button", { name: /create a community/i }).click();
  const big = Buffer.alloc(300 * 1024, 7);
  await page.locator('input[type="file"]').setInputFiles({ name: "big.png", mimeType: "image/png", buffer: big });
  await expect(page.getByText(/over 256KB/i)).toBeVisible();
});
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e --prefix packages/fez-desktop -- onboarding-community`
Expected: PASS (fix spec selectors against real copy as in Task 11)

- [ ] **Step 3: Commit**

```bash
git add packages/fez-desktop/tests
git commit -m "e2e(gui): community doors + profile guardrails"
```

---

### Task 13: Playwright — the welcome kickoff renders in #welcome

**Files:**
- Create: `packages/fez-desktop/tests/e2e/welcome-kickoff.spec.ts`, `packages/fez-desktop/tests/e2e/helpers/relay.ts`
- Modify: `packages/fez-desktop/playwright.config.ts` (spawn fez-relay alongside preview)

**Interfaces:**
- Consumes: real `packages/fez-relay/dist/cli.js` (built; `cold-start-bootstrap.test.ts`'s spawnRelay shows the invocation — mirror it), the mock bridge, `ensureWelcome` path (Task 6).

- [ ] **Step 1: Relay helper + config**

`helpers/relay.ts`: export `spawnRelay(port): Promise<{ url, kill }>` copied in shape from `packages/fez-evals/tests/cold-start-bootstrap.test.ts:44` (read it; keep the same store-dir-per-run + ready-wait). Config: add a `globalSetup` (or a per-spec `test.beforeAll`) that builds fez-relay if `dist/cli.js` is missing (`npm run build --prefix packages/fez-relay`) and spawns it on 7777.

- [ ] **Step 2: The kickoff spec**

The app in the browser is the OWNER: bridge returns a fixed identity, localStorage carries `fez-relay=ws://127.0.0.1:7777`, and the test relay is claimed by that key (mirror how cold-start-bootstrap claims — whatever `ensure_local_relay`/NIP-11 owner seeding it does, do it via the relay's CLI flags or the client API in the spec's beforeAll).

```ts
import { test, expect } from "@playwright/test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("post-onboarding boot: #welcome opens with hello, opener, summons, intros, kickoff", async ({ page }) => {
  const owner = generateSecretKey();
  const agents = { fez: generateSecretKey(), drift: generateSecretKey(), quill: generateSecretKey() };
  const relay = await spawnRelay(7777, { owner: getPublicKey(owner) });

  const keyFor: Record<string, string> = {
    default: bytesToHex(owner),
    "agent:fez": bytesToHex(agents.fez), "agent:drift": bytesToHex(agents.drift), "agent:quill": bytesToHex(agents.quill),
  };
  await installMockBridge(page, {
    get_identity: () => keyFor.default, // overridden per-account below
    provider_key_present: () => true, // authed: the choreography must fire
    read_persona: () => "---\nharness: pi\nprovider: local-56105ece7a\nmodel: mock/model-a\neffort: medium\n---\n",
  });
  // get_identity is account-keyed — the static table can't branch, so the
  // bridge needs one stateful exception. Extend installMockBridge with an
  // optional `dynamic: { get_identity: keyFor }` map handled inside the
  // init script (lookup by args.account, fall back to keyFor.default).
  await page.addInitScript((keys) => { (window as any).__FEZ_TEST_KEYS__ = keys; }, keyFor);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("fez-relay", "ws://127.0.0.1:7777"));
  await page.reload();

  // The app boots as owner, bootstraps #welcome, and @fez speaks.
  await expect(page.getByText("welcome")).toBeVisible({ timeout: 15_000 }); // the channel header/sidebar
  await expect(page.getByText(/welcome in/i)).toBeVisible({ timeout: 15_000 }); // hello
  await expect(page.getByText(/I'm @fez, your guide/i)).toBeVisible();
  await expect(page.getByText(/introduce yourself in a sentence or two/i)).toBeVisible({ timeout: 15_000 }); // summons

  // The teammates' intros are REAL turns in production; here the test
  // plays them: publish two intro messages signed by drift/quill keys.
  // (Signed with nostr-tools in the test process, published over ws.)
  // ...publish kind 47103 {h: bootstrap-welcome, content: "I'm drift..."} as drift,
  //    then the same as quill — reuse the wire shape from welcome-core's
  //    ensureMarkedMessage (tags [["h", id]], no marker)...

  await expect(page.getByText(/What can we help you build/i)).toBeVisible({ timeout: 130_000 }); // kickoff after intros
  await relay.kill();
});
```

The `get_identity` account-branching and the intro-publishing block are the two places this spec does real work — implement them in `bridge.ts`/`relay.ts` helpers, not inline. The kickoff timeout is long because `ensureStarterTeam` polls at 5s intervals with a 120s backstop; with both intros seeded promptly it lands in ~10s — keep 130s as ceiling, not expectation.

- [ ] **Step 3: Run**

Run: `npm run test:e2e --prefix packages/fez-desktop -- welcome-kickoff`
Expected: PASS — and this is the test that proves the GUI story end to end minus real LLMs

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/tests packages/fez-desktop/playwright.config.ts
git commit -m "e2e(gui): welcome kickoff renders in #welcome against a real relay"
```

---

### Task 14: Real-hardware e2e + ship gate

**Files:**
- Modify: `packages/fez-desktop/scripts/e2e-cold-start.sh`

**Interfaces:**
- Consumes: everything. This is the composition witness on the mini.

- [ ] **Step 1: Update the script's expectations**

- Seeded personas: seed `fez.md` AND `drift.md`/`quill.md` is NOT needed — the app writes them; drop any seeding that fights the new flow (keep identity + chutes key seeding).
- Remove/stop asserting sentinel startup for the GUI path; instead assert the managed-agent logs exist: `~/.fez/logs/fez.desktop.log`, `drift.desktop.log`, `quill.desktop.log` non-empty.
- Poll the relay store for, in order: HELLO_MARKER, OPENER_MARKER, TEAM_MARKER in channel `bootstrap-welcome` (not bootstrap-general), then **two messages authored by pubkeys that are neither owner nor @fez** (the real intros), then KICKOFF_MARKER.
- Assert the channel event for `bootstrap-welcome` exists with name "welcome".

- [ ] **Step 2: Run on the mini**

Run: `bash packages/fez-desktop/scripts/e2e-cold-start.sh`
Expected: PASS end to end — real Tauri, real bundle, real pi turns via the seeded Chutes key. Debug failures with the dumped logs; a teammate that never intro'd is a managed-spawn or roster bug, and the fix belongs in Task 5/6, not in looser assertions.

- [ ] **Step 3: Manual pass checklist (human, on the mini or a fresh account)**

- Walk the real wizard: harness page shows Claude's true state; Fez READY.
- Verify one real provider key (Chutes at minimum) → models + effort appear.
- Claude READY path: pick Claude Code as default harness.
- Land in #welcome; watch hello → opener → summons → two real intros → kickoff.
- Quit the app: `pgrep -f fez-agent` shows nothing (children die with the app).
- Run the TUI with `fez sentinel` up, then open the app: personas don't double-spawn.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/scripts/e2e-cold-start.sh
git commit -m "e2e: cold start asserts the #welcome choreography with desktop-managed agents"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** decisions 1-9 → Tasks 7-9 (shell/order/skip), 8 (harnesses, providers, effort), 9 (doors, profile, team), 6 (#welcome, readiness, roster), 5 (managed agents, sentinel deference), 3 (provider table), 4 (effort/model plumbing), 1 (cast names), 10-13 (GUI test centerpiece), 14 (mini gate + manual pass). Spec's "diagnosis" section is dissolved into Task 14 step 2 (pi turn completion witnessed on real hardware) per the amended architecture.
- **Known open risk, stated:** Anthropic's `/v1/models` listing with `x-api-key` is the verification path while chat goes through pi's OpenAI-compat local-models entry — if Anthropic's compat endpoint rejects the local-models shape at turn time, the Task 14 mini run catches it; fallback is dropping Anthropic from PROVIDERS v1 (one table row).
- **Type consistency:** `Brain`/`BrainSelection` naming — Onboarding's wizard state is `Brain` (Task 8), ModelPicker's existing `BrainSelection` is untouched. `buildFezPersonaMd(harness, model?, provider?, effort?)` signature is identical in Tasks 2, 8, 9. `WELCOME_CHANNEL_ID = "bootstrap-welcome"` everywhere.
- **Placeholder scan:** the two deliberate read-first points (pixel-sprite component props in Task 9, spawnRelay shape in Task 13) name the exact file to read and the contract to match — they're pointers to existing code, not TBDs.
