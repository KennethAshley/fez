# Mining in Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mining nav-view catalog with a chat-native UX — a `#mining` channel whose active miners are threads, each managed by a thread-view card — and add schema-declared per-subnet config (retiring the manual `FEZ_MINE_FORWARD_ENV` env dance).

**Architecture:** Phase A is a headless config core: a `config` schema on the `SubnetMiner` contract, `fez-mine config` CLI verbs (non-secrets in state, secrets in the macOS keychain), and config resolved into `ctx.config` at launch. Phases B–D are the desktop chat surface: a `mining` channel source, a `registerThreadView` management card per miner thread, a New-miner picker with a config form, and headless-posted lifecycle replies. The `fez-mine` CLI stays the engine the GUI drives; the machine seam / LiumMachine / sentinel are unchanged.

**Tech Stack:** TypeScript ESM, esbuild, vitest, macOS `security` keychain CLI, Fez chat seams (`ChannelsAccess.ensure/say`, `GuiClient.sendChannelMessage/messages/registerThreadView/openThread`), React iife gui parts (`api.React`/`h`).

**Spec:** `docs/superpowers/specs/2026-09-08-mining-in-chat-design.md`

## Global Constraints

- Plain commit messages, no trailers of any kind. Never push — Ken tests first.
- Per-package `npm test` (vitest) + `npm run check` (tsc --noEmit) + `npm run build` clean at every commit. fez-bazaar (sibling repo `/Users/ken/Projects/Fez/fez-bazaar`, Task 5 only) uses `bun run typecheck && bun run build:ext && bun test`.
- ESM everywhere; `node:` builtins. Bins carry `#!/usr/bin/env node` + the realpath main-module guard already in `run.ts`.
- Secrets NEVER touch plain state or the webview: the value goes to the keychain via a node CLI verb; the GUI only ever learns "set" / "not set". Same custody stance as fez-wallet.
- fez-mining's cli/run esbuild line already externalizes `@fezchat/bittensor` and `@fezchat/lium`; keep that. The gui iife line is separate and bundles its own.
- The gui part is the legacy `api.React`/`h` element-returning mount form (matches the current `gui.tsx` and fez-wallet), NOT `createRoot`.
- Root-message identity format is pinned in ONE place (`minerRootLine`/`parseMinerRoot`), used by every poster and matcher.
- macOS-only for secrets (the app is a Mac desktop); the keychain module shells `security`.

---

### Task 1: Config contract — ConfigField on SubnetMiner, config on MinerContext (fez-extension-api)

**Files:**
- Modify: `packages/fez-extension-api/src/miner.ts`

**Interfaces:**
- Produces (all later tasks + descriptors): `ConfigField`, `SubnetMiner.config?: ConfigField[]`, `MinerContext.config: Record<string, string | number | boolean>`.

- [ ] **Step 1: Add the types.** Above `SubnetMiner`:

```ts
/**
 * One configurable field a subnet miner exposes. The harness renders a
 * form from these, stores the values per-miner (secrets in the OS
 * keychain, everything else in state), and hands the resolved values to
 * the descriptor as MinerContext.config at launch.
 */
export interface ConfigField {
  key: string;                                  // unique per descriptor
  label: string;
  type: "string" | "number" | "boolean" | "select" | "secret";
  default?: string | number | boolean;
  options?: string[];                           // for type "select"
  required?: boolean;
  help?: string;
}
```

Add to `SubnetMiner` (after `requirements`): `config?: ConfigField[];`
Add to `MinerContext` (after `env`):

```ts
  /** Resolved config values for this miner — non-secrets from state,
   *  secrets from the keychain, merged over the schema defaults. In-memory
   *  only; the descriptor maps these into how it runs (env vars, args). */
  config: Record<string, string | number | boolean>;
```

- [ ] **Step 2: Build** — `npm run build --prefix packages/fez-extension-api`; expected clean, `dist/miner.d.ts` carries the new members.
- [ ] **Step 3: Commit** — `git add packages/fez-extension-api && git commit -m "extension-api: config schema on the miner contract"`

---

### Task 2: Keychain secret store (fez-mining)

**Files:**
- Create: `packages/fez-mining/src/secrets.ts`
- Test: `packages/fez-mining/tests/secrets.test.ts`

**Interfaces:**
- Produces: `secretAccount(netuid, persona, key): string`; `setSecret(netuid, persona, key, value): void`; `getSecret(netuid, persona, key): string | undefined`; `hasSecret(netuid, persona, key): boolean`; `deleteSecret(netuid, persona, key): void`. Service is the literal `"fez-mining"`.

- [ ] **Step 1: Write the failing test** (pure account-name shaping is the unit-testable part; the `security` calls are integration and covered by a guarded round-trip):

```ts
// packages/fez-mining/tests/secrets.test.ts
import { describe, expect, it } from "vitest";
import { secretAccount } from "../src/secrets.js";

describe("secretAccount", () => {
  it("namespaces by netuid:persona:key", () => {
    expect(secretAccount(553, "quill", "providerKey")).toBe("553:quill:providerKey");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**, then implement:

```ts
// packages/fez-mining/src/secrets.ts
import { execFileSync } from "node:child_process";

const SERVICE = "fez-mining";
export const secretAccount = (netuid: number, persona: string, key: string): string =>
  `${netuid}:${persona}:${key}`;

export function setSecret(netuid: number, persona: string, key: string, value: string): void {
  // -U updates if present; -w takes the secret from argv (fine on macOS, the
  // desktop is single-user). Same `security` surface fez-wallet uses.
  execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", secretAccount(netuid, persona, key), "-w", value], { stdio: ["ignore", "ignore", "ignore"] });
}
export function getSecret(netuid: number, persona: string, key: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", secretAccount(netuid, persona, key), "-w"], { encoding: "utf8" }).replace(/\n$/, "");
  } catch { return undefined; }
}
export const hasSecret = (netuid: number, persona: string, key: string): boolean =>
  getSecret(netuid, persona, key) !== undefined;
export function deleteSecret(netuid: number, persona: string, key: string): void {
  try { execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", secretAccount(netuid, persona, key)], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* absent is fine */ }
}
```

- [ ] **Step 3: Run — expect PASS.** Then a manual guarded round-trip (not a committed test — writes the real keychain): `node -e "const s=require('./dist/... ')"` is awkward pre-build; instead verify after Task 4's build via `fez-mine config set`. Note that in the report.
- [ ] **Step 4: `npm run check` clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining: keychain secret store, scoped per miner"`

---

### Task 3: config resolution + MinerEntry.config (fez-mining state)

**Files:**
- Modify: `packages/fez-mining/src/state.ts` (MinerEntry.config)
- Create: `packages/fez-mining/src/config.ts`
- Test: `packages/fez-mining/tests/config.test.ts`

**Interfaces:**
- Consumes: `ConfigField` (Task 1), the secret store (Task 2).
- Produces:
  - `MinerEntry.config?: Record<string, string | number | boolean>` (non-secret stored values only).
  - `resolveConfig(schema: ConfigField[] | undefined, stored: Record<string, string|number|boolean> | undefined, readSecret: (key: string) => string | undefined): Record<string, string | number | boolean>` — merge order: schema defaults → stored non-secrets → resolved secrets. Secret fields absent from the keychain are simply omitted (not defaulted).
  - `validateConfig(schema, values): string | null` — returns the first missing-required field's label, or null.

- [ ] **Step 1: Add two fields to `MinerEntry` in state.ts** (after `attention`): `config?: Record<string, string | number | boolean>;` and `threadRootId?: string;` (the `#mining` channel event id of this miner's root message — set once by the GUI when it posts the root, read by the headless to target lifecycle replies; the single-poster dedupe, so GUI and headless never both create a root).
- [ ] **Step 2: Write the failing test**

```ts
// packages/fez-mining/tests/config.test.ts
import { describe, expect, it } from "vitest";
import { resolveConfig, validateConfig } from "../src/config.js";
import type { ConfigField } from "@fezchat/extension-api";

const schema: ConfigField[] = [
  { key: "provider", label: "Provider", type: "select", options: ["chutes", "anthropic"], default: "chutes" },
  { key: "dailyCap", label: "Daily cap", type: "number", default: 8 },
  { key: "providerKey", label: "Provider key", type: "secret", required: true },
];

describe("resolveConfig", () => {
  it("layers defaults, stored, secrets", () => {
    const out = resolveConfig(schema, { dailyCap: 12 }, (k) => (k === "providerKey" ? "sk-x" : undefined));
    expect(out).toEqual({ provider: "chutes", dailyCap: 12, providerKey: "sk-x" });
  });
  it("omits a secret that isn't set", () => {
    const out = resolveConfig(schema, {}, () => undefined);
    expect(out.providerKey).toBeUndefined();
    expect(out.provider).toBe("chutes");
  });
});
describe("validateConfig", () => {
  it("names the first missing required field", () => {
    expect(validateConfig(schema, { provider: "chutes" })).toBe("Provider key");
    expect(validateConfig(schema, { provider: "chutes", providerKey: "x" })).toBeNull();
  });
});
```

- [ ] **Step 3: Run — expect FAIL, implement `config.ts`:**

```ts
import type { ConfigField } from "@fezchat/extension-api";
type Val = string | number | boolean;

export function resolveConfig(
  schema: ConfigField[] | undefined,
  stored: Record<string, Val> | undefined,
  readSecret: (key: string) => string | undefined
): Record<string, Val> {
  const out: Record<string, Val> = {};
  for (const f of schema ?? []) {
    if (f.type === "secret") {
      const s = readSecret(f.key);
      if (s !== undefined) out[f.key] = s;
      continue;
    }
    if (stored && f.key in stored) out[f.key] = stored[f.key];
    else if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
export function validateConfig(schema: ConfigField[] | undefined, values: Record<string, Val>): string | null {
  for (const f of schema ?? []) if (f.required && (values[f.key] === undefined || values[f.key] === "")) return f.label;
  return null;
}
```

- [ ] **Step 4: Run — expect PASS; `npm run check` clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining: config resolution + MinerEntry.config"`

---

### Task 4: `fez-mine config` verbs + resolve config into ctx at launch (fez-mining)

**Files:**
- Modify: `packages/fez-mining/src/cli.ts` (config get|set|unset dispatch)
- Modify: `packages/fez-mining/src/run.ts` (build `ctx.config`)
- Modify: `packages/fez-mining/src/descriptors.ts` if it exposes the loaded descriptor to run.ts — read it first; the resolver needs the descriptor's schema for the netuid.
- Test: `packages/fez-mining/tests/cli-config.test.ts`

**Interfaces:**
- Consumes: secrets (Task 2), resolveConfig/validateConfig + MinerEntry.config (Task 3), loadDescriptors (existing).
- Produces:
  - CLI: `fez-mine config get --netuid N --persona P [--json]` prints the merged view with secrets shown as `"set"`/`"unset"` (never the value); `fez-mine config set --netuid N --persona P --key K --value V [--secret]` writes a secret to the keychain (`--secret`) or a value to `MinerEntry.config` in state; `fez-mine config unset --netuid N --persona P --key K` clears either.
  - CLI: `fez-mine thread set-root --netuid N --persona P --root <eventId>` records `MinerEntry.threadRootId` (the GUI calls this after posting the root; the headless reads it). One-liner: read state, upsert the entry's `threadRootId`, write.
  - `run.ts`: at launch, `ctx.config = resolveConfig(descriptor.config, entry.config, (k) => getSecret(netuid, persona, k))`. `ctx` gains `config`.

- [ ] **Step 1: Write the failing test** for the pure config-get shaping (secrets masked):

```ts
// packages/fez-mining/tests/cli-config.test.ts
import { describe, expect, it } from "vitest";
import { maskConfigView } from "../src/cli.js";
import type { ConfigField } from "@fezchat/extension-api";

const schema: ConfigField[] = [
  { key: "provider", label: "P", type: "string", default: "chutes" },
  { key: "providerKey", label: "K", type: "secret", required: true },
];

describe("maskConfigView", () => {
  it("shows non-secrets, masks secrets to set/unset", () => {
    const v = maskConfigView(schema, { provider: "anthropic" }, (k) => k === "providerKey");
    expect(v).toEqual({ provider: "anthropic", providerKey: "set" });
    expect(maskConfigView(schema, {}, () => false)).toEqual({ provider: "chutes", providerKey: "unset" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL, implement.** Export `maskConfigView(schema, stored, hasSecretFn)` in cli.ts (pure: non-secrets from stored-or-default, secrets → "set"/"unset"). Add the `config` case to the argv dispatch (mirror the existing `--netuid`/`--persona`/`--json` flag parsing; add `--key`, `--value`, `--secret` flags). `set --secret` → `setSecret`; `set` (no --secret) → read state, `upsertMiner` with merged `config`, write; `unset` clears from the right place; `get` prints `maskConfigView`.
- [ ] **Step 3: Wire run.ts.** Where `ctx` is built (run.ts ~line 313), resolve config: load the descriptor for this netuid (loadDescriptors already runs in the runner — reuse it), then `const config = resolveConfig(descriptor?.config, entry?.config, (k) => getSecret(netuid, persona, k));` and add `config` to the `ctx` object. Read entry from state.
- [ ] **Step 4: Run — full fez-mining suite + `npm run check` clean; build.** Live guarded check (report, not committed test): `fez-mine config set --netuid 553 --persona quill --key providerKey --value test --secret`, then `fez-mine config get --netuid 553 --persona quill --json` shows `providerKey: "set"`; `fez-mine config unset …` clears it (verify with `security find-generic-password -s fez-mining` gone).
- [ ] **Step 5: Commit** — `git add packages/fez-mining && git commit -m "fez-mining: config CLI verbs + resolve config into ctx at launch"`

---

### Task 5: bazaar + gradients declare config, map it in start() (fez-bazaar sibling + fez-gradients)

**Files:**
- Modify: `/Users/ken/Projects/Fez/fez-bazaar/src/miner-part.ts` (structural mirror + `config` + map in start)
- Modify: `packages/fez-gradients/src/miner-part.ts`
- Test: `packages/fez-gradients/tests/descriptor.test.ts` (assert the new config schema)

**Interfaces:**
- Consumes: `ctx.config` (Tasks 1, 4). bazaar uses a structural type mirror (no `@fezchat/extension-api` runtime dep in that repo); extend the mirror's `MinerContext` with `config: Record<string, string|number|boolean>` and add `config?` to its `SubnetMiner` mirror.
- Produces: bazaar declares `provider`/`model`/`dailyCap`/`secretKey`/`providerKey`; gradients declares its keys. Both map `ctx.config` into the env they pass to `ctx.machine.exec` (bazaar) / their run command (gradients).

- [ ] **Step 1: bazaar — read `src/miner/main.ts` env names first** (already catalogued in miner-part.ts's comment): `BAZAAR_PROVIDER`, `BAZAAR_MODEL`, `BAZAAR_SECRET_KEY`, the daily-cap env, and the provider key env (`CHUTES_API_KEY`/`ANTHROPIC_API_KEY` by provider). Pin the exact daily-cap env var from main.ts.
- [ ] **Step 2: bazaar — add the schema + mapping.** In `miner-part.ts`, add to the `bazaar` descriptor:

```ts
config: [
  { key: "provider", label: "LLM provider", type: "select", options: ["chutes", "anthropic", "openai", "openrouter"], default: "chutes" },
  { key: "model", label: "Model", type: "string", help: "override the profile default" },
  { key: "dailyCap", label: "Daily spend cap (tTAO)", type: "number", default: 8 },
  { key: "secretKey", label: "Miner Nostr key (hex)", type: "secret", help: "else resolved from the keychain" },
  { key: "providerKey", label: "Provider API key", type: "secret" },
],
```

Then in `start()`, build the env from `ctx.config` instead of relying on inherited env: map `provider`→`BAZAAR_PROVIDER`, `model`→`BAZAAR_MODEL` (only if set), `dailyCap`→ the pinned cap env, `secretKey`→`BAZAAR_SECRET_KEY` (only if set), `providerKey`→ the provider's key env name (chutes→`CHUTES_API_KEY`, anthropic→`ANTHROPIC_API_KEY`, etc. — a small provider→envName map). Keep `...ctx.env` as the base for the non-config vars the harness still sets (owner pk, relay). This is what removes the `FEZ_MINE_FORWARD_ENV` dependency — the values now come from `ctx.config`.

- [ ] **Step 3: gradients — declare its config** (from Task 9's earlier repo research in the LiumMachine plan; re-pin the exact keys): its provider/API `secret` fields and any run flags, mapped into the run command's env. Update `tests/descriptor.test.ts` to assert `miners[0].config` has the expected keys.
- [ ] **Step 4: Verify.** fez-gradients: `npm test` + `check` + `build`. fez-bazaar: `bun run typecheck && bun run build:ext`.
- [ ] **Step 5: Live phase-A proof (the payoff).** Rebuild+relink both; `fez-mine config set --netuid 553 --persona quill --key provider --value chutes`, `… --key model --value deepseek-ai/DeepSeek-V3.2-TEE`, `… --key providerKey --value <chutes key> --secret`, `… --key secretKey --value <quill nostr key> --secret`; then `fez-mine start --netuid 553 --persona quill --machine lium --json` **with NO `FEZ_MINE_FORWARD_ENV` and NO provider env vars in the shell** — the miner must connect on chutes/DeepSeek from config alone. Stop + teardown. Record in the report. (Ken supervises the spend, ~cents.)
- [ ] **Step 6: Commit both repos** (bazaar by explicit path in its repo; gradients in the fez repo). Plain messages, no trailers.

---

### Task 6: shared root-line helpers + channel ensure (fez-mining gui foundation)

**Files:**
- Create: `packages/fez-mining/src/thread.ts`
- Test: `packages/fez-mining/tests/thread.test.ts`

**Interfaces:**
- Produces (Tasks 7, 8, 10):
  - `minerRootLine(netuid: number, persona: string): string` → `⛏ mining · netuid <N> · persona <P>`.
  - `parseMinerRoot(content: string): { netuid: number; persona: string } | null`.
  - `MINING_SOURCE = "mining"`, `MINING_CHANNEL_NAME = "mining"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-mining/tests/thread.test.ts
import { describe, expect, it } from "vitest";
import { minerRootLine, parseMinerRoot } from "../src/thread.js";

describe("miner root line", () => {
  it("round-trips netuid + persona", () => {
    const line = minerRootLine(553, "quill");
    expect(line).toBe("⛏ mining · netuid 553 · persona quill");
    expect(parseMinerRoot(line)).toEqual({ netuid: 553, persona: "quill" });
  });
  it("rejects unrelated content", () => {
    expect(parseMinerRoot("hello world")).toBeNull();
    expect(parseMinerRoot("⛏ mining · netuid abc · persona x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL, implement:**

```ts
export const MINING_SOURCE = "mining";
export const MINING_CHANNEL_NAME = "mining";
export const minerRootLine = (netuid: number, persona: string): string =>
  `⛏ mining · netuid ${netuid} · persona ${persona}`;
const RE = /^⛏ mining · netuid (\d+) · persona (\S+)$/;
export function parseMinerRoot(content: string): { netuid: number; persona: string } | null {
  const m = RE.exec(content.trim());
  return m ? { netuid: Number(m[1]), persona: m[2] } : null;
}
```

- [ ] **Step 3: PASS; check clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining: pinned miner-thread root line helpers"`

---

### Task 7: GUI — the miner list nav view opens threads; New-miner + config form in the picker

**Files:**
- Modify: `packages/fez-mining/src/gui.tsx` (replace the catalog page)
- Modify: `packages/fez-mining/src/gui-rows.ts` if a config-form field model helper belongs there (pure; testable)
- Test: `packages/fez-mining/tests/gui-config-form.test.ts`

**Interfaces:**
- Consumes: `subnetRows`/`machineChoices` (existing), `minerRootLine`/`parseMinerRoot`/`MINING_SOURCE`/`MINING_CHANNEL_NAME` (Task 6), `client.ensureChannel`/`channelsFrom`/`sendChannelMessage`/`messages`/`openThread` (GuiClient), `api.processes.run` (fez-mine), the descriptor `config` schema (surfaced via a new `fez-mine describe --netuid N --json` verb — add it: prints the descriptor's `{name, requirements, config}` for a covered netuid, from loadDescriptors).
- Produces: the ⛏ nav view now shows active miners (each row → `openThread(channelId, rootId)`), and a **New miner** button opens the picker (subnet → machine → config form → persona → confirm → `config set` per field → `start` → ensure channel + post `minerRootLine` root → openThread).

Realization note (faithful to the spec's intent within the available seams): the host offers no "rail entry that opens a channel," so the ⛏ entry stays a `registerNavView` whose body is the **miner list + New-miner**; per-miner management is the thread-view card (Task 8) reached via `openThread` into the ensured `#mining` channel. The threads and card ARE the chat-native management the spec calls for.

- [ ] **Step 1: Add `fez-mine describe`** to cli.ts (dispatch case): `describe --netuid N --json` → `JSON.stringify({ netuid, name, requirements, config })` from the matching loaded descriptor, or exit 1 "no descriptor for netuid N". Unit-test the pure shaping if a seam exists; else covered by the picker walkthrough.
- [ ] **Step 2: Config-form field model test** (the pure part of the form):

```ts
// packages/fez-mining/tests/gui-config-form.test.ts
import { describe, expect, it } from "vitest";
import { initialFormValues } from "../src/gui-rows.js";
import type { ConfigField } from "@fezchat/extension-api";
const schema: ConfigField[] = [
  { key: "provider", label: "P", type: "select", options: ["chutes"], default: "chutes" },
  { key: "cap", label: "C", type: "number", default: 8 },
  { key: "k", label: "K", type: "secret", required: true },
];
describe("initialFormValues", () => {
  it("seeds from defaults, secrets blank", () => {
    expect(initialFormValues(schema)).toEqual({ provider: "chutes", cap: 8, k: "" });
  });
});
```

- [ ] **Step 3: Implement** `initialFormValues(schema)` in gui-rows.ts (defaults; secrets → ""). Then rewrite `gui.tsx`'s `MiningPage`: keep the active-miners section (each row's click → resolve its `(netuid,persona)` root in the `#mining` channel and `openThread`); replace the always-on catalog with a **New miner** button that runs the picker steps in-view (reuse subnetRows for the subnet step, machineChoices for the machine step, and render the config form from `describe`'s schema). On confirm: for each non-secret field `fez-mine config set --key --value`; for each secret field `fez-mine config set --key --value --secret`; then `fez-mine start …`; then `const channelId = await client.ensureChannel({name: MINING_CHANNEL_NAME, source: MINING_SOURCE})`. Post the root, then RECOVER its id from the channel — `sendChannelMessage` returns `unknown`, not an event id, so the id comes from `client.messages(channelId)`: `await client.sendChannelMessage(minerRootLine(netuid, persona), {channelId})`, then find the matching root `const root = client.messages(channelId).find(m => { const p = parseMinerRoot(m.content); return p && p.netuid === netuid && p.persona === persona; })`. Persist it `fez-mine thread set-root --netuid N --persona P --root <root.id>` (so the headless targets replies and neither side re-posts — Task 4 verb), then `openThread(channelId, root.id)`. Guard the "root not found yet" case (message not absorbed) with a short retry or defer to the headless. Keep the confirm-burn dialog + lium $/hr + balance-floor from the current code. Active-miner rows open a thread the same way — look the root up in `client.messages(channelId)` by content, or use `entry.threadRootId` when present.
- [ ] **Step 4: `npm test` + `check` + `build` clean (dist/gui.js emits).** Commit — `git add packages/fez-mining && git commit -m "fez-mining gui: miner list + New-miner picker with config form"`

---

### Task 8: GUI — the miner thread-view management card

**Files:**
- Modify: `packages/fez-mining/src/gui.tsx` (register the thread view)

**Interfaces:**
- Consumes: `parseMinerRoot` (Task 6), `registerThreadView` + `api.processes.run` + `client` (GuiClient), `fez-mine status/logs/config/stop`.
- Produces: `api.registerThreadView("mining-miner", (root) => parseMinerRoot(root) !== null, render)` — a card over any miner thread showing status + log tail + config + Stop.

- [ ] **Step 1: Add `fez-mine logs`** to cli.ts: `logs --netuid N --persona P [--lines 12]` tails `<home>/mining/<netuid>-<persona>/miner-child.log` (and falls back to `miner.log`); prints plain text; empty if absent.
- [ ] **Step 2: Implement the card** in gui.tsx: `registerThreadView("mining-miner", (rootContent) => parseMinerRoot(rootContent) !== null, (props, host) => …)`. From `props.rootContent` parse `(netuid, persona)`. The card component polls `fez-mine status --json` (find this miner's row), renders the status line (dot, uid, machine/pod/$hr/endpoint, attention), a `fez-mine logs` tail (poll 10s), the config (via `fez-mine config get --json` + `describe` schema — render read-only with an "Edit" toggle that reuses the Task 7 form and on save runs `config set` then `stop`+`start`), and a **Stop** button (`fez-mine stop`). Mount-form: `createRoot`-free `api.React` render returning the element, or the host-node mount form per `MountRender` — match how the current gui renders.
- [ ] **Step 3: Build clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining gui: miner thread management card"`
- [ ] **Step 4: Desktop walkthrough (Ken):** relaunch; ⛏ Mining lists miners; New miner → pick bazaar/553 → config form → confirm → a thread appears in #mining → open it → the card shows status/logs/config/Stop; Stop works. This is the phase B+C verification (mount components aren't unit-tested).

---

### Task 9: headless — reconcile roots + post lifecycle replies

**Files:**
- Modify: `packages/fez-mining/src/headless.ts`
- Create: `packages/fez-mining/src/lifecycle.ts` (pure transition → message)
- Test: `packages/fez-mining/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `channels.ensure`/`channels.say` (ChannelsAccess, present on the headless part when a key + relay exist), state (miners + their machine/attention/lastExit), `minerRootLine`/`parseMinerRoot` (Task 6).
- Produces:
  - `lifecycleMessage(prev: MinerEntry | undefined, next: MinerEntry): string | null` — pure: returns the reply text for a transition (started, stopped, reprovisioned [provisions grew], needs-attention [attention set], died [lastExit changed while desired running]), or null when nothing noteworthy changed.
  - The headless reconcile: on each tick, `channels.ensure({name: MINING_CHANNEL_NAME, source: MINING_SOURCE})`; for each state miner that HAS a `threadRootId` (the GUI posted its root — the headless never posts roots, avoiding the dedupe problem), post any `lifecycleMessage(prevSnapshot, miner)` diff as `channels.say(channelId, text, {threadRoot: miner.threadRootId})`. A CLI-started miner with no `threadRootId` simply gets no timeline (acceptable — that user isn't in the GUI). Keep the prev snapshot in `api.storage` keyed by `(netuid, persona)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-mining/tests/lifecycle.test.ts
import { describe, expect, it } from "vitest";
import { lifecycleMessage } from "../src/lifecycle.js";
const base = { netuid: 553, persona: "quill", hotkey: "5F", desired: "running" as const };

describe("lifecycleMessage", () => {
  it("announces a fresh start", () => {
    expect(lifecycleMessage(undefined, { ...base })).toMatch(/started/i);
  });
  it("announces stop", () => {
    expect(lifecycleMessage({ ...base }, { ...base, desired: "stopped" })).toMatch(/stopped/i);
  });
  it("announces needs-attention", () => {
    expect(lifecycleMessage({ ...base }, { ...base, attention: "capped" })?.toLowerCase()).toContain("attention");
  });
  it("says nothing on a no-op poll", () => {
    expect(lifecycleMessage({ ...base }, { ...base })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL, implement `lifecycle.ts`** (compare the fields named above; return the first noteworthy transition's text or null). Then wire `headless.ts`: extend the existing scheduled task — after the reconcile it already does, `ensure` the channel, and for each miner post any `lifecycleMessage(prevSnapshot, miner)` diff (keep the prev snapshot in `api.storage`), ensuring/caching the root id first. Guard everything on `channels` being present (no key/relay → skip silently).
- [ ] **Step 3: Run — PASS; check + build clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining headless: reconcile miner threads + lifecycle replies"`
- [ ] **Step 4: Desktop walkthrough (Ken):** with the desktop open, start a miner → a root appears in #mining and a "started" reply lands; stop → a "stopped" reply; the timeline reads as history. This is phase D verification.

---

### Task 10: retire `FEZ_MINE_FORWARD_ENV` fallback + docs

**Files:**
- Modify: `packages/fez-mining/src/run.ts` (env building)
- Modify: `packages/fez-mining/README.md` (if present) / the extension's help text

**Interfaces:**
- Consumes: `ctx.config` now carries the miner's secrets/settings (Task 5 maps them).

- [ ] **Step 1:** In run.ts, the remote-env branch currently reads `FEZ_MINE_FORWARD_ENV`. Now that descriptors pull what they need from `ctx.config`, narrow the forwarded env to only harness-set vars (owner pk, relay) — drop the `FEZ_MINE_FORWARD_ENV` allowlist read, OR keep it as a documented escape hatch but no longer the primary path. Ruling for the implementer: KEEP it as an escape hatch (some future descriptor may want a raw env passthrough) but update the comment to say config is the primary path; do not remove the mechanism. Confirm no test asserts it's the only path.
- [ ] **Step 2:** Update any README/help that told users to set `FEZ_MINE_FORWARD_ENV` to point at `fez-mine config` instead.
- [ ] **Step 3: Full suite + check + build clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining: config is the primary secret path; FEZ_MINE_FORWARD_ENV is a documented escape hatch"`

---

## Deliberate exclusions (from the spec)

- Live log streaming to the relay (card polls a tail); non-macOS keychain; multiple/per-subnet mining channels. All YAGNI per spec §7.

## Phase map (each ships alone)

- **A (headless config core):** Tasks 1–5, 10. Ends the `FEZ_MINE_FORWARD_ENV` dance; live-proven on a pod.
- **B (channel + card):** Tasks 6, 8 (+ the nav-view shell in 7).
- **C (New-miner picker + form):** Task 7.
- **D (lifecycle timeline):** Task 9.
