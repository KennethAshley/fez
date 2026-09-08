# Mining Agent Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two capabilities on top of shipped mining-as-agent-capability: a gated
conversational config tool (set non-secret params by talking; refuse secrets), and
proactive DM pings (quill DMs you once when a miner needs a human).

**Architecture:** Both are additions to files shipped last feature. E adds two `mineArgs`
builders + a pure `classifyConfigKey` + a `mining_config` MCP tool that reads the subnet
schema via `fez-mine describe` and refuses `type:"secret"` fields. D adds a
`dmOwnerAsPersona` custody helper (mirrors the shipped `postAsPersona`) + pure
`attentionDmText`/`shouldDmAttention`, wired into the reconcile's needs-attention branch.

**Tech Stack:** TypeScript, esbuild, `@modelcontextprotocol/sdk`, `zod`,
`@fezchat/protocol` (`getKey`, `RelayConnection`, `resolveRelays`, `buildDmWraps`),
`nostr-tools/pure` (`finalizeEvent`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-mining-agent-followups-design.md`

## Global Constraints

- **Commit messages PLAIN — NO trailers** (no Co-Authored-By, no Claude-Session).
- **No secret ever transits an LLM turn.** `mining_config` refuses `type:"secret"` fields
  BEFORE any set; it reads the schema (types), never secret values.
- **Restart stays gated.** `mining_config` sets the value and reports "restart to apply" —
  it does NOT stop/start the miner (a Lium restart costs money; the agent restarts via the
  existing gated `mining_stop`/`mining_start` only on user confirmation).
- **DM is persona→owner only.** `dmOwnerAsPersona` sends to `ctx.ownerPubkey`, signed by
  `getKey('agent:'+persona)`; never a third party.
- **Persona scoping structural:** `mining_config` takes no persona arg; it acts on
  `FEZ_AGENT_PERSONA`.
- **DM fires once per transition:** dedup via `api.storage` marker `dm-attention:<minerKey>`.
- **TDD.** Build+typecheck the package before committing:
  `cd packages/fez-mining && npm run check && npm run build && npx vitest --run`.
- **Deploy for testing is extension-only** (copy `dist/mcp.js`/`headless.js` + relink); NO
  app rebuild (no host code touched).

---

## File Structure

**Stage E — `packages/fez-mining/`**
- Modify `src/mine-cli.ts` — add `mineArgs.describe`, `mineArgs.configSet`, and the pure
  `classifyConfigKey(schema, key)`.
- Modify `src/mcp.ts` — add the `mining_config` tool.
- Modify `tests/mcp-tools.test.ts` — builder + `classifyConfigKey` tests.

**Stage D — `packages/fez-mining/`**
- Modify `src/persona-post.ts` — add `dmOwnerAsPersona`.
- Create `src/attention-dm.ts` — pure `attentionDmText` + `shouldDmAttention`.
- Create `tests/attention-dm.test.ts`.
- Modify `src/headless.ts` — DM on needs-attention transition; clear marker on respawn.

---

## STAGE E — Gated conversational config

### Task E1: CLI arg builders + `classifyConfigKey`

**Files:**
- Modify: `packages/fez-mining/src/mine-cli.ts`
- Modify: `packages/fez-mining/tests/mcp-tools.test.ts`

**Interfaces:**
- Produces: `mineArgs.describe(netuid)`, `mineArgs.configSet(persona, netuid, key, value)`,
  and `classifyConfigKey(schema: ConfigField[], key: string): "secret" | "unknown" | "ok"`.

- [ ] **Step 1: Write failing tests** — append to `packages/fez-mining/tests/mcp-tools.test.ts`

```ts
import { classifyConfigKey } from "../src/mine-cli.js"; // add to the existing import line

describe("mineArgs describe/configSet", () => {
  it("describe names the netuid and json", () => {
    expect(mineArgs.describe(56)).toEqual(["describe", "--netuid", "56", "--json"]);
  });
  it("configSet omits --secret (this path never writes secrets)", () => {
    expect(mineArgs.configSet("quill", 553, "dailyCap", "5")).toEqual(
      ["config", "set", "--netuid", "553", "--persona", "quill", "--key", "dailyCap", "--value", "5"]
    );
  });
});

describe("classifyConfigKey", () => {
  const schema = [
    { key: "dailyCap", label: "Daily cap", type: "number" as const },
    { key: "providerKey", label: "API key", type: "secret" as const },
  ];
  it("returns 'secret' for a secret-typed field", () => {
    expect(classifyConfigKey(schema, "providerKey")).toBe("secret");
  });
  it("returns 'ok' for a non-secret field", () => {
    expect(classifyConfigKey(schema, "dailyCap")).toBe("ok");
  });
  it("returns 'unknown' for a key not in the schema", () => {
    expect(classifyConfigKey(schema, "nope")).toBe("unknown");
  });
  it("returns 'unknown' against an empty/absent schema", () => {
    expect(classifyConfigKey([], "dailyCap")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/fez-mining && npx vitest --run tests/mcp-tools.test.ts`
Expected: FAIL — `classifyConfigKey` not exported, `mineArgs.describe` undefined.

- [ ] **Step 3: Implement in `packages/fez-mining/src/mine-cli.ts`**

Add the type import at the top (verify the path against how `src/gui.tsx` imports
`ConfigField` — it is the extension-api miner contract):
```ts
import type { ConfigField } from "@fezchat/extension-api";
```
Add to the `mineArgs` object:
```ts
  describe: (netuid: number) => ["describe", "--netuid", String(netuid), "--json"],
  configSet: (persona: string, netuid: number, key: string, value: string) =>
    ["config", "set", "--netuid", String(netuid), "--persona", persona, "--key", key, "--value", value],
```
Add the pure classifier (module scope):
```ts
/** Is `key` settable by a non-secret config path? Reads the subnet's declared
 *  ConfigField schema (from `fez-mine describe`). Secrets are refused so no key
 *  ever transits an LLM turn; unknown keys are refused so typos don't write junk. */
export function classifyConfigKey(schema: ConfigField[], key: string): "secret" | "unknown" | "ok" {
  const field = schema.find((f) => f.key === key);
  if (!field) return "unknown";
  if (field.type === "secret") return "secret";
  return "ok";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/fez-mining && npx vitest --run tests/mcp-tools.test.ts`
Expected: PASS (existing + 6 new).

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/fez-mining && npm run check
git add packages/fez-mining/src/mine-cli.ts packages/fez-mining/tests/mcp-tools.test.ts
git commit -m "fez-mining: describe/configSet arg builders + classifyConfigKey (secret/unknown/ok)"
```

### Task E2: `mining_config` MCP tool

**Files:**
- Modify: `packages/fez-mining/src/mcp.ts`

**Interfaces:**
- Consumes: `runMine`, `mineArgs.describe`, `mineArgs.configSet`, `classifyConfigKey`
  (Task E1); the module-level `persona` and `text()` helper already in `mcp.ts`.

- [ ] **Step 1: Add the tool** — in `packages/fez-mining/src/mcp.ts`, before `const transport = ...`

Extend the existing mine-cli import to include `classifyConfigKey`, and add a
`ConfigField` type import (same path E1 used). Then:
```ts
server.registerTool(
  "mining_config",
  {
    description:
      "Set a NON-secret config parameter on THIS agent's miner for a subnet (e.g. daily cap, model). Secrets like API keys are REFUSED here — set those in the mining cockpit. The change applies on the next restart; ask the user before restarting (a Lium restart costs money).",
    inputSchema: {
      netuid: z.number().int().describe("the subnet"),
      key: z.string().describe("the config field to set"),
      value: z.string().describe("the new value"),
    },
  },
  async ({ netuid, key, value }) => {
    const desc = runMine(mineArgs.describe(netuid));
    if (desc.code !== 0) return text(`could not read netuid ${netuid} config schema: ${desc.stderr.trim()}`);
    let schema: ConfigField[] = [];
    try { schema = (JSON.parse(desc.stdout).config ?? []) as ConfigField[]; } catch { schema = []; }
    const verdict = classifyConfigKey(schema, key);
    if (verdict === "secret") return text(`"${key}" is a secret — set it in the mining cockpit, not chat.`);
    if (verdict === "unknown") {
      const settable = schema.filter((f) => f.type !== "secret").map((f) => f.key);
      return text(`netuid ${netuid} has no settable field "${key}". Settable: ${settable.join(", ") || "(none)"}.`);
    }
    const out = runMine(mineArgs.configSet(persona, netuid, key, value));
    if (out.code !== 0) return text(`could not set ${key}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`set ${key} = ${value} for netuid ${netuid}. This applies on the next restart — say the word and I'll stop and restart the miner.`);
  }
);
```

- [ ] **Step 2: Build + verify boot**

Run: `cd packages/fez-mining && npm run check && npm run build && npx vitest --run`
Then confirm the server still boots: `FEZ_AGENT_PERSONA=quill node dist/mcp.js </dev/null`
(exits cleanly on stdin close, no crash).
Expected: check/build clean, full suite green.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-mining/src/mcp.ts
git commit -m "fez-mining: mining_config tool — set non-secret params, refuse secrets, restart stays gated"
```

---

## STAGE D — Proactive DM attention pings

### Task D1: `dmOwnerAsPersona` + attention text/dedup helpers

**Files:**
- Modify: `packages/fez-mining/src/persona-post.ts`
- Create: `packages/fez-mining/src/attention-dm.ts`
- Create: `packages/fez-mining/tests/attention-dm.test.ts`

**Interfaces:**
- Produces: `dmOwnerAsPersona(persona, ownerPubkey, text): Promise<string>` (persona-post.ts);
  `attentionDmText(netuid, persona, reason): string` and
  `shouldDmAttention(prevMarker: string | undefined, currentAttention: string): boolean`
  (attention-dm.ts).

- [ ] **Step 1: Write failing tests** — `packages/fez-mining/tests/attention-dm.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { attentionDmText, shouldDmAttention } from "../src/attention-dm.js";

describe("attentionDmText", () => {
  it("names the netuid and the reason", () => {
    const t = attentionDmText(56, "quill", "reprovision cap reached");
    expect(t).toContain("netuid 56");
    expect(t).toContain("reprovision cap reached");
  });
});

describe("shouldDmAttention", () => {
  it("fires on a new attention reason (no prior marker)", () => {
    expect(shouldDmAttention(undefined, "died")).toBe(true);
  });
  it("does not re-fire for the same reason", () => {
    expect(shouldDmAttention("died", "died")).toBe(false);
  });
  it("fires again when the reason changes", () => {
    expect(shouldDmAttention("died", "deregistered")).toBe(true);
  });
  it("treats a cleared marker ('') as no prior", () => {
    expect(shouldDmAttention("", "died")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/fez-mining && npx vitest --run tests/attention-dm.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/fez-mining/src/attention-dm.ts`**

```ts
/** quill's DM when a miner needs a human. Pure so the wording is testable. */
export function attentionDmText(netuid: number, persona: string, reason: string): string {
  return `⛏ heads up — your netuid ${netuid} miner needs you: ${reason}. Reply and I'll act (e.g. "stop it").`;
}

/** DM only on a TRANSITION: the current attention reason differs from the last
 *  one we DM'd (a cleared marker is stored as "" → any real reason re-fires). */
export function shouldDmAttention(prevMarker: string | undefined, currentAttention: string): boolean {
  return (prevMarker ?? "") !== currentAttention;
}
```

- [ ] **Step 4: Add `dmOwnerAsPersona` to `packages/fez-mining/src/persona-post.ts`**

Extend the `@fezchat/protocol` import to include `buildDmWraps`:
```ts
import { RelayConnection, getKey, resolveRelays, buildDmWraps } from "@fezchat/protocol";
```
Add the function (mirrors `postAsPersona`'s custody + disconnect):
```ts
/**
 * DM the owner a status line signed as `agent:<persona>` — same custody path
 * as postAsPersona, but a NIP-17 gift-wrapped DM (buildDmWraps → publish both
 * the peer wrap and the sender self-copy) instead of a channel message.
 * Returns the peer wrap's event id. Throws if the persona has no local key.
 */
export async function dmOwnerAsPersona(persona: string, ownerPubkey: string, text: string): Promise<string> {
  const keyHex = getKey(`agent:${persona}`);
  if (!keyHex) throw new Error(`no local key for agent "${persona}"`);
  const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const relay = new RelayConnection({
    urls: resolveRelays(),
    authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
  });
  const { toPeer, toSelf } = buildDmWraps(secret, ownerPubkey, text);
  try {
    await relay.publish(toPeer);
    await relay.publish(toSelf);
  } finally {
    relay.disconnect();
  }
  return toPeer.id;
}
```
(`finalizeEvent` is already imported in this file.)

- [ ] **Step 5: Run tests + build**

Run: `cd packages/fez-mining && npx vitest --run tests/attention-dm.test.ts && npm run check && npm run build`
Expected: attention-dm tests pass; check/build clean (the new DM bundle must not break the
existing headless/mcp/gui builds).

- [ ] **Step 6: Commit**

```bash
git add packages/fez-mining/src/attention-dm.ts packages/fez-mining/tests/attention-dm.test.ts packages/fez-mining/src/persona-post.ts
git commit -m "fez-mining: dmOwnerAsPersona + attention DM text/dedup helpers"
```

### Task D2: Wire the reconcile to DM on a needs-attention transition

**Files:**
- Modify: `packages/fez-mining/src/headless.ts`

**Interfaces:**
- Consumes: `dmOwnerAsPersona`, `attentionDmText`, `shouldDmAttention` (Task D1);
  `minerKey` (already imported from `./state.js`), `ctx.ownerPubkey`, `api.storage`.

- [ ] **Step 1: Add imports** — in `packages/fez-mining/src/headless.ts`

```ts
import { postAsPersona, dmOwnerAsPersona } from "./persona-post.js"; // extend the existing line
import { attentionDmText, shouldDmAttention } from "./attention-dm.js";
```

- [ ] **Step 2: DM in the needs-attention branch**

Find the `if (action === "needs-attention") {` branch. After its existing
`writeState(...)` and `console.error(...)`, before `continue;`, insert:
```ts
        const dmKey = `dm-attention:${minerKey(m.netuid, m.persona)}`;
        const prevMarker = await api.storage.get<string>(dmKey);
        if (shouldDmAttention(prevMarker, m.attention ?? "")) {
          try {
            await dmOwnerAsPersona(
              m.persona,
              ctx.ownerPubkey,
              attentionDmText(m.netuid, m.persona, m.attention ?? "needs attention")
            );
            await api.storage.set(dmKey, m.attention ?? "");
          } catch (err) {
            console.error(`mining-reconcile: failed to DM owner for ${m.netuid}:${m.persona}`, err);
          }
        }
```

- [ ] **Step 3: Clear the marker on respawn (re-arm the ping)**

Find the respawn write — the line
`await writeState(home, upsertMiner(fresh, { ...entry, pid, startedAt: Date.now() }));`
(after `spawnDetached`). Immediately after it, add:
```ts
        // Recovered → clear the attention ping marker so a future problem pings again.
        await api.storage.set(`dm-attention:${minerKey(entry.netuid, entry.persona)}`, "");
```

- [ ] **Step 4: Build + verify the suite stays green**

Run: `cd packages/fez-mining && npm run check && npm run build && npx vitest --run`
Expected: check/build clean; full suite green (the reconcile's existing tests must still
pass — this only adds a DM side-effect gated on `shouldDmAttention`).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-mining/src/headless.ts
git commit -m "fez-mining headless: DM the owner (as the persona) once per needs-attention transition"
```

---

## Self-Review

**1. Spec coverage:**
- Sub-project E (gated config tool, refuse secrets, no auto-restart) → E1 (builders +
  classifyConfigKey) + E2 (mining_config tool). ✅
- Sub-project D (DM on needs-attention transition, dedup, persona→owner) → D1
  (dmOwnerAsPersona + text/dedup helpers) + D2 (reconcile wiring + marker clear). ✅
- Security: no-secret-in-turn (E2 refuses before set), restart-gated (E2 reports, doesn't
  restart), DM to ownerPubkey only (D1/D2). ✅
- Build order E before D (E is pure/testable; D's acceptance is a live smoke). ✅

**2. Placeholder scan:** No TBD/TODO. Every code step has real code. The one "verify the
import path against gui.tsx" note (E1 Step 3) is a copy-from-sibling instruction for a type
import, not a placeholder.

**3. Type consistency:** `mineArgs.describe/configSet` and `classifyConfigKey` (E1) are
consumed unchanged in E2. `dmOwnerAsPersona`/`attentionDmText`/`shouldDmAttention` (D1)
consumed unchanged in D2. `minerKey` is the existing `./state.js` export. `m.attention` is
the `MinerEntry.attention` string set by the reconcile. `ctx.ownerPubkey` is on
`ScheduledTaskContext`. Consistent.

**Notes for the executor:**
- Work in an isolated branch/worktree (SDD setup).
- D2 has no direct unit test (the reconcile branch needs ctx/storage/relay); its logic is
  covered by `shouldDmAttention`'s unit tests + the suite staying green, and its acceptance
  is the live smoke: force a needs-attention state (or observe a real reprovision-cap hit)
  and confirm exactly one DM from quill arrives, with no repeat on the next 120s tick.
- Deploy for testing: rebuild fez-mining, copy `dist/headless.js` → `~/.fez/extensions/fez-mining.js`
  and `dist/mcp.js` stays at its registered path; no app rebuild.
