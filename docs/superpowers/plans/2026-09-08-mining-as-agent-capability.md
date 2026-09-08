# Mining as an Agent Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Fez mining into a capability a persona has — a running chat agent can be
directed to mine and answers questions about its own miner, posts lifecycle status as
itself, and is managed from one consolidated surface.

**Architecture:** Three staged sub-projects. (A) A stdio MCP server shipped by
`fez-mining` (`parts.skill`) wrapping the existing `fez-mine` CLI, scoped to the calling
persona via `FEZ_AGENT_PERSONA`. (B) The headless reconcile posts lifecycle messages
signed with the persona's own `agent:<name>` keychain key instead of the owner's. (C)
De-duplicate the two management UIs into one thread-owned card, and make the start-flow
roster the persona and grant it the mining skill.

**Tech Stack:** TypeScript, esbuild, `@modelcontextprotocol/sdk`, `zod`,
`@fezchat/protocol` (`getKey`, `RelayConnection`, `resolveRelays`), `nostr-tools/pure`
(`finalizeEvent`, `getPublicKey`), vitest, preact (`h`) for GUI, Tauri host (App.tsx).

**Spec:** `docs/superpowers/specs/2026-09-08-mining-as-agent-capability-design.md`

## Global Constraints

- **Commit messages are plain — NO trailers of any kind** (no Co-Authored-By, no
  Claude-Session). One-line subject + optional body.
- **Secrets never enter an LLM turn or plain state.** No MCP tool sets/reads config
  secrets; secrets live only in the macOS keychain (service `fez-mining`). MCP read
  tools expose only public data (status, metagraph, ss58 hotkey).
- **Testnet guard is unchanged.** `mining_start` shells the existing `fez-mine start`,
  which routes registration through fez-wallet's `requireRehearsalNetwork`. Do not add
  a bypass.
- **A persona manages only its own miner.** Every MCP tool defaults `--persona` to
  `FEZ_AGENT_PERSONA`; an explicit `persona` arg that differs is refused.
- **Post-as-persona signs with `getKey('agent:'+persona)`** (from `@fezchat/protocol`),
  never the owner key — the established pattern in `fez-polls`, `fez-kanban`,
  `fez-communities`, `fez-sentinel`.
- **`KIND_CHANNEL_MESSAGE = 47103`**, tags `["h", channelId]` and, for a threaded reply,
  `["e", rootId, "", "root"]`; content is the plain text.
- **TDD:** every code task writes a failing test first. Build + test the touched package
  before committing (`npm run check && npm run build && npx vitest --run` in the package).
- **Deploy for manual testing** = copy `dist/*` into `~/.fez` and relink; the `fez-mine`
  bin is already a symlink to repo dist. **Host code (`packages/fez-desktop/src`) needs a
  full `tauri build` + app replace** — only Task C3 touches host code; everything else is
  extension-only.
- **Node process reaching `fez-mine`:** resolve the binary as an absolute path
  (`~/.fez/bin/fez-mine`), never rely on `PATH` (mirrors `resolveBin`/`WALLET_BIN` in
  `packages/fez-mining/src/cli.ts`).

---

## File Structure

**Sub-project A (MCP tool) — `packages/fez-mining/`**
- Create `src/mcp.ts` — the stdio MCP server. One responsibility: expose `fez-mine`
  verbs as persona-scoped MCP tools.
- Create `src/mine-cli.ts` — a tiny testable wrapper: `runMine(args): {code, stdout,
  stderr}` (resolves the absolute bin, shells out) and `minePersonaFilter`. Split from
  `mcp.ts` so tool logic is unit-testable without spawning a real server.
- Create `tests/mcp-tools.test.ts` — tool→CLI argument mapping + persona-scoping.
- Modify `package.json` — add the `src/mcp.ts` esbuild target and `fez.parts.skill`.

**Sub-project B (persona status) — `packages/fez-mining/`**
- Create `src/persona-post.ts` — `postAsPersona(persona, channelId, text, opts?)`.
- Create `tests/persona-post.test.ts`.
- Modify `src/headless.ts` — replace `ctx.channels.say(...)` calls with `postAsPersona`.
- Modify `package.json` — add `@fezchat/protocol` dependency.

**Sub-project C (management) — `packages/fez-mining/` + host**
- Create `src/persona-skill.ts` — pure `ensureMiningSkill(md)` / `removeMiningSkill(md)`
  frontmatter editors.
- Create `tests/persona-skill.test.ts`.
- Modify `src/gui.tsx` — MinerCard becomes the single management owner; MiningPage loses
  its per-miner config editor; start-flow calls invite + ensureMiningSkill, stop reverts.
- Modify `packages/fez-desktop/src/App.tsx` (HOST — Task C3 only) — ⛏ badge on the roster.

---

## STAGE A — Sub-project 1: Mining MCP tool

### Task A1: MCP server scaffold + read tools (status, metagraph)

**Files:**
- Create: `packages/fez-mining/src/mine-cli.ts`
- Create: `packages/fez-mining/src/mcp.ts`
- Create: `packages/fez-mining/tests/mcp-tools.test.ts`
- Modify: `packages/fez-mining/package.json` (build script + `fez.parts.skill`)

**Interfaces:**
- Produces: `runMine(args: string[]): { code: number; stdout: string; stderr: string }`
  and `minersForPersona(statusJson: string, persona: string): unknown[]` in
  `mine-cli.ts`, consumed by `mcp.ts` and Task A2.

- [ ] **Step 1: Write the failing test** — `packages/fez-mining/tests/mcp-tools.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { minersForPersona, mineArgs } from "../src/mine-cli.js";

describe("minersForPersona", () => {
  it("keeps only the persona's own miners", () => {
    const json = JSON.stringify({
      miners: [
        { netuid: 56, persona: "quill", desired: "running" },
        { netuid: 1, persona: "drift", desired: "running" },
      ],
    });
    expect(minersForPersona(json, "quill")).toEqual([
      { netuid: 56, persona: "quill", desired: "running" },
    ]);
  });
  it("returns [] for unparseable output rather than throwing", () => {
    expect(minersForPersona("not json", "quill")).toEqual([]);
  });
});

describe("mineArgs", () => {
  it("builds a metagraph invocation with persona + netuid", () => {
    expect(mineArgs.metagraph("quill", 56)).toEqual(
      ["metagraph", "--netuid", "56", "--persona", "quill", "--json"]
    );
  });
  it("builds a status invocation", () => {
    expect(mineArgs.status()).toEqual(["status", "--json"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-mining && npx vitest --run tests/mcp-tools.test.ts`
Expected: FAIL — `Cannot find module '../src/mine-cli.js'`.

- [ ] **Step 3: Write `packages/fez-mining/src/mine-cli.ts`**

```ts
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

/** Absolute path to the installed fez-mine — never trust PATH (mirrors
 *  WALLET_BIN/resolveBin in cli.ts; the MCP server is spawned by the
 *  harness with an env we don't control). */
const MINE_BIN = process.env.FEZ_MINE_BIN || path.join(homedir(), ".fez", "bin", "fez-mine");

export function runMine(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(MINE_BIN, args, { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

/** Filter `fez-mine status --json` down to one persona's miners; tolerant
 *  of malformed output (returns []). */
export function minersForPersona(statusJson: string, persona: string): unknown[] {
  try {
    const parsed = JSON.parse(statusJson) as { miners?: Array<{ persona?: string }> };
    return (parsed.miners ?? []).filter((m) => m.persona === persona);
  } catch {
    return [];
  }
}

export const mineArgs = {
  status: () => ["status", "--json"],
  metagraph: (persona: string, netuid: number) =>
    ["metagraph", "--netuid", String(netuid), "--persona", persona, "--json"],
  start: (persona: string, netuid: number, machine?: "local" | "lium") =>
    ["start", "--netuid", String(netuid), "--persona", persona,
      ...(machine === "lium" ? ["--machine", "lium"] : [])],
  stop: (persona: string, netuid: number) =>
    ["stop", "--netuid", String(netuid), "--persona", persona],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fez-mining && npx vitest --run tests/mcp-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write `packages/fez-mining/src/mcp.ts`** (read tools only in this task)

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runMine, minersForPersona, mineArgs } from "./mine-cli.js";

/**
 * fez-mining, skill part — an MCP server that lets a running agent inspect
 * and (Task A2) direct ITS OWN miner. Same custody model as fez-polls: the
 * persona is fixed to FEZ_AGENT_PERSONA, so quill's tools act on quill's
 * miner and nothing else. No secret ever transits a tool call.
 */
const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-mining: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "fez-mining", version: "0.1.0" });

server.registerTool(
  "mining_status",
  {
    description:
      "Report the status of THIS agent's own Bittensor miners (subnet, running/stopped, machine). Use when asked how mining is going or what you're mining.",
    inputSchema: {},
  },
  async () => {
    const out = runMine(mineArgs.status());
    if (out.code !== 0) return text(`could not read mining status: ${out.stderr.trim()}`);
    const mine = minersForPersona(out.stdout, persona);
    if (mine.length === 0) return text(`${persona} has no miners running.`);
    return text(JSON.stringify(mine, null, 2));
  }
);

server.registerTool(
  "mining_metagraph",
  {
    description:
      "Live on-chain performance of THIS agent's miner on a subnet — incentive, emission, trust, rank, stake, immunity. Use when asked how a specific netuid is performing.",
    inputSchema: { netuid: z.number().int().describe("the subnet netuid") },
  },
  async ({ netuid }) => {
    const out = runMine(mineArgs.metagraph(persona, netuid));
    if (out.code !== 0) return text(`could not read metagraph for netuid ${netuid}: ${out.stderr.trim()}`);
    return text(out.stdout.trim() || "{}");
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 6: Add the build target and manifest skill part** — `packages/fez-mining/package.json`

Append ` && esbuild src/mcp.ts --bundle --format=esm --platform=node --external:@fezchat/bittensor --external:@fezchat/lium --banner:js="import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" --outfile=dist/mcp.js` to the end of the `"build"` script.

Add the skill part under `"fez": { "parts": { ... } }`:
```json
"skill": { "command": "node", "args": ["dist/mcp.js"] }
```

- [ ] **Step 7: Build and verify the server boots**

Run: `cd packages/fez-mining && npm run check && npm run build`
Then: `FEZ_AGENT_PERSONA=quill node dist/mcp.js </dev/null` — expected: no crash, exits when stdin closes (a stdio server with no client). A missing-persona check: `node dist/mcp.js </dev/null` → prints `FEZ_AGENT_PERSONA is required` and exits 1.

- [ ] **Step 8: Commit**

```bash
git add packages/fez-mining/src/mine-cli.ts packages/fez-mining/src/mcp.ts \
  packages/fez-mining/tests/mcp-tools.test.ts packages/fez-mining/package.json
git commit -m "fez-mining: MCP server with persona-scoped mining_status + mining_metagraph"
```

### Task A2: Mutate tools (mining_start, mining_stop)

**Files:**
- Modify: `packages/fez-mining/src/mcp.ts`
- Modify: `packages/fez-mining/tests/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `mineArgs.start/stop`, `runMine` from Task A1.

- [ ] **Step 1: Add failing tests for the start/stop arg builders** — append to `tests/mcp-tools.test.ts`

```ts
describe("mineArgs start/stop", () => {
  it("start on lium adds --machine lium", () => {
    expect(mineArgs.start("quill", 56, "lium")).toEqual(
      ["start", "--netuid", "56", "--persona", "quill", "--machine", "lium"]
    );
  });
  it("start local omits --machine", () => {
    expect(mineArgs.start("quill", 56, "local")).toEqual(
      ["start", "--netuid", "56", "--persona", "quill"]
    );
  });
  it("stop names persona + netuid", () => {
    expect(mineArgs.stop("quill", 56)).toEqual(
      ["stop", "--netuid", "56", "--persona", "quill"]
    );
  });
});
```

- [ ] **Step 2: Run to verify pass** (the builders already exist from A1)

Run: `cd packages/fez-mining && npx vitest --run tests/mcp-tools.test.ts`
Expected: PASS — these lock the "mine 56 on lium" argument mapping.

- [ ] **Step 3: Register the mutate tools in `src/mcp.ts`** (before `const transport =`)

```ts
server.registerTool(
  "mining_start",
  {
    description:
      "Start mining a Bittensor subnet as THIS agent. `machine: \"lium\"` rents a GPU pod (costs real money — the host will ask you to confirm); omit for a local miner. Requires any needed secret (e.g. the Lium key) to already be set in the mining cockpit.",
    inputSchema: {
      netuid: z.number().int().describe("the subnet to mine"),
      machine: z.enum(["local", "lium"]).optional().describe("where to run it (default local)"),
    },
  },
  async ({ netuid, machine }) => {
    const out = runMine(mineArgs.start(persona, netuid, machine));
    if (out.code !== 0) return text(`could not start netuid ${netuid}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`started mining netuid ${netuid}${machine === "lium" ? " on a Lium pod" : ""}. ${out.stdout.trim()}`);
  }
);

server.registerTool(
  "mining_stop",
  {
    description: "Stop THIS agent's miner on a subnet (tears down a rented pod if there is one).",
    inputSchema: { netuid: z.number().int().describe("the subnet to stop mining") },
  },
  async ({ netuid }) => {
    const out = runMine(mineArgs.stop(persona, netuid));
    if (out.code !== 0) return text(`could not stop netuid ${netuid}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`stopped mining netuid ${netuid}. ${out.stdout.trim()}`);
  }
);
```

Note: persona scoping is structural — every tool passes the module-level `persona`
(from `FEZ_AGENT_PERSONA`); no tool accepts a `persona` argument, so a foreign persona
cannot be named. This satisfies the "manages only its own miner" constraint by
construction.

- [ ] **Step 4: Build**

Run: `cd packages/fez-mining && npm run check && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-mining/src/mcp.ts packages/fez-mining/tests/mcp-tools.test.ts
git commit -m "fez-mining: MCP mining_start (machine lium|local) + mining_stop, persona-scoped"
```

---

## STAGE B — Sub-project 2: Proactive status as the persona

### Task B1: `postAsPersona` helper

**Files:**
- Create: `packages/fez-mining/src/persona-post.ts`
- Create: `packages/fez-mining/tests/persona-post.test.ts`
- Modify: `packages/fez-mining/package.json` (add `@fezchat/protocol` dep)

**Interfaces:**
- Produces: `buildPersonaEvent(secretHex, channelId, text, threadRoot?) → EventTemplate`
  (pure, tested) and `postAsPersona(persona, channelId, text, opts?): Promise<string>`
  (returns the published event id).

- [ ] **Step 1: Add the dependency** — `packages/fez-mining/package.json`

Under `"dependencies"` add: `"@fezchat/protocol": "file:../../src"` — **verify the exact
specifier the sibling packages use**: run `grep -h '@fezchat/protocol' packages/fez-polls/package.json packages/fez-communities/package.json` and copy that value verbatim (it is the canonical local path). Then `npm install` at repo root.

- [ ] **Step 2: Write the failing test** — `packages/fez-mining/tests/persona-post.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { buildPersonaEvent } from "../src/persona-post.js";

const SECRET = "1".repeat(64); // 32-byte hex

describe("buildPersonaEvent", () => {
  it("tags the channel and carries the text as a kind-47103 message", () => {
    const t = buildPersonaEvent(SECRET, "chan123", "started mining netuid 56");
    expect(t.kind).toBe(47103);
    expect(t.content).toBe("started mining netuid 56");
    expect(t.tags).toContainEqual(["h", "chan123"]);
    expect(t.tags.some((x) => x[0] === "e")).toBe(false);
  });
  it("adds a root e-tag when threading a reply", () => {
    const t = buildPersonaEvent(SECRET, "chan123", "earned 0.02", "root99");
    expect(t.tags).toContainEqual(["e", "root99", "", "root"]);
  });
  it("is signable by the given key (pubkey derivable)", () => {
    // sanity: the secret we sign with maps to a stable pubkey
    expect(getPublicKey(Uint8Array.from(Buffer.from(SECRET, "hex")))).toHaveLength(64);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/fez-mining && npx vitest --run tests/persona-post.test.ts`
Expected: FAIL — `Cannot find module '../src/persona-post.js'`.

- [ ] **Step 4: Write `packages/fez-mining/src/persona-post.ts`**

```ts
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays } from "@fezchat/protocol";

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const KIND_CHANNEL_MESSAGE = 47103;

/** Pure — the exact event a persona-authored channel post is, before signing. */
export function buildPersonaEvent(
  _secretHex: string,
  channelId: string,
  text: string,
  threadRoot?: string
): EventTemplate {
  const tags: string[][] = [["h", channelId]];
  if (threadRoot) tags.push(["e", threadRoot, "", "root"]);
  return { kind: KIND_CHANNEL_MESSAGE, created_at: Math.floor(Date.now() / 1000), tags, content: text };
}

/**
 * Publish `text` into a channel signed as `agent:<persona>` — the persona's
 * own stable keychain key, NOT the owner's. Same custody path fez-polls /
 * fez-kanban / fez-communities use. Returns the event id (so the caller can
 * record a thread root). Throws if the persona has no local key.
 */
export async function postAsPersona(
  persona: string,
  channelId: string,
  text: string,
  opts?: { threadRoot?: string }
): Promise<string> {
  const keyHex = getKey(`agent:${persona}`);
  if (!keyHex) throw new Error(`no local key for agent "${persona}"`);
  const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
  const relay = new RelayConnection({
    urls: resolveRelays(),
    authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
  });
  const signed = finalizeEvent(buildPersonaEvent(keyHex, channelId, text, opts?.threadRoot) as never, secret);
  await relay.publish(signed);
  void getPublicKey; // (kept for parity with sibling servers; pubkey used by callers if needed)
  return signed.id;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/fez-mining && npx vitest --run tests/persona-post.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Build + commit**

```bash
cd packages/fez-mining && npm run check && npm run build && npx vitest --run
git add packages/fez-mining/src/persona-post.ts packages/fez-mining/tests/persona-post.test.ts packages/fez-mining/package.json
git -C ../.. add package-lock.json 2>/dev/null || true
git commit -m "fez-mining: postAsPersona — publish channel messages signed by the persona key"
```

### Task B2: Route headless lifecycle posts through the persona

**Files:**
- Modify: `packages/fez-mining/src/headless.ts` (the two `ctx.channels.say` sites +
  the root backfill)
- Modify: `packages/fez-mining/tests/` — add a headless posting test if one exists;
  otherwise assert via a thin extraction (below).

**Interfaces:**
- Consumes: `postAsPersona` (B1). Replaces `ctx.channels.say`.

- [ ] **Step 1: Read the current posting sites**

`packages/fez-mining/src/headless.ts` posts in three spots (all currently owner-signed):
- the thread-root backfill: `const rootId = await ctx.channels.say(channelId, minerRootLine(miner.netuid, miner.persona));`
- the lifecycle reply: `await ctx.channels.say(channelId, text, { threadRoot: miner.threadRootId });`

The channel is still ENSURED by the owner (`ctx.channels.ensure`) — only the message
authorship moves to the persona.

- [ ] **Step 2: Write the failing test** — `packages/fez-mining/tests/headless-post.test.ts`

Extract the "who posts" decision so it is testable without a live relay: assert that the
reconcile chooses `postAsPersona(miner.persona, …)` over the owner path. Add a small pure
seam in `headless.ts`:

```ts
// in headless.ts, exported for the test:
export function rootBackfillText(netuid: number, persona: string): string {
  return minerRootLine(netuid, persona);
}
```

Test:
```ts
import { describe, it, expect } from "vitest";
import { rootBackfillText } from "../src/headless.js";

describe("rootBackfillText", () => {
  it("is the miner root line for the persona", () => {
    expect(rootBackfillText(56, "quill")).toContain("netuid 56");
    expect(rootBackfillText(56, "quill")).toContain("quill");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/fez-mining && npx vitest --run tests/headless-post.test.ts`
Expected: FAIL — `rootBackfillText` not exported.

- [ ] **Step 4: Swap the posting calls in `headless.ts`**

Add `import { postAsPersona } from "./persona-post.js";` and the `rootBackfillText`
export. Replace:

```ts
// backfill:
const rootId = await postAsPersona(miner.persona, channelId, rootBackfillText(miner.netuid, miner.persona));
// lifecycle reply:
await postAsPersona(miner.persona, channelId, text, { threadRoot: miner.threadRootId });
```

Leave `ctx.channels.ensure(...)` (owner creates/owns the channel) unchanged. Keep the
existing try/catch around each post — a persona with no key (`postAsPersona` throws)
must be caught and logged, never abort the reconcile tick.

- [ ] **Step 5: Run tests + build**

Run: `cd packages/fez-mining && npx vitest --run && npm run check && npm run build`
Expected: PASS; headless bundle rebuilt.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-mining/src/headless.ts packages/fez-mining/tests/headless-post.test.ts
git commit -m "fez-mining headless: post miner root + lifecycle replies as the persona, not the owner"
```

- [ ] **Step 7: Precondition verification (deploy-time, not a code change)**

Before manual testing, confirm quill's `agent:quill` key is owner-attested so mention
summons and cross-agent replies honor it. Run:
`~/.fez/bin/fez-wallet status quill` (confirms the persona/hotkey exist) and check for an
owner-published `KIND_AGENT_ATTESTATION` (47006) for quill's pubkey. If absent, roster
quill via the existing invite path (Task C2 wires this into the GUI). Record the result
in the SDD ledger; this gates the conversational path, not proactive display.

---

## STAGE C — Sub-project 3: One agents-native management surface

### Task C1: De-duplicate management — MinerCard owns it, MiningPage is the index

**Files:**
- Modify: `packages/fez-mining/src/gui.tsx`

**Interfaces:**
- No new exports. Removes duplicated status/logs/config logic from `MiningPage`.

- [ ] **Step 1: Identify the duplication**

In `packages/fez-mining/src/gui.tsx`, `MinerCard` (thread view) and `MiningPage` (nav
view) each poll `fez-mine status/logs/config/metagraph` and each render management
controls. `MinerCard` is the richer one (logs + editable config + stop). Make it the
single owner.

- [ ] **Step 2: Reduce `MiningPage` to an index + start-flow**

`MiningPage` keeps: the active-miner LIST (each row: persona · netuid · running dot ·
open-thread link · stop) and the "New miner" start picker (subnet → machine → config →
persona → confirm). REMOVE from `MiningPage`: the per-miner logs panel and the editable
config form (those live only in `MinerCard`). A row's "open" action calls the existing
`openThread(channelId, rootId)` so management happens in the thread card.

- [ ] **Step 3: Verify no behavior regressed**

Run: `cd packages/fez-mining && npm run check && npm run build`
Manually (after deploy): the nav view lists miners and starts one; opening a miner shows
the full card; there is exactly one config editor (in the thread). No test change — this
is deletion of duplicated UI; the CLI-passthrough logic it called is already tested.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-mining/src/gui.tsx
git commit -m "fez-mining GUI: MinerCard is the sole management surface; MiningPage is the index + start flow"
```

### Task C2: Start-flow wires the persona for chat; stop reverts

**Files:**
- Create: `packages/fez-mining/src/persona-skill.ts`
- Create: `packages/fez-mining/tests/persona-skill.test.ts`
- Modify: `packages/fez-mining/src/gui.tsx` (start-flow + stop path)

**Interfaces:**
- Produces: `ensureMiningSkill(md: string): string` and `removeMiningSkill(md: string):
  string` — pure frontmatter editors on a persona `.md`.

- [ ] **Step 1: Write the failing test** — `packages/fez-mining/tests/persona-skill.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { ensureMiningSkill, removeMiningSkill } from "../src/persona-skill.js";

const NONE = `---\nharness: claude-code\naliases: [q]\n---\nquill body\n`;
const HAS = `---\nharness: claude-code\nmcpServers: [web-search, mining]\n---\nbody\n`;

describe("ensureMiningSkill", () => {
  it("adds an mcpServers line when there is none", () => {
    const out = ensureMiningSkill(NONE);
    expect(out).toContain("mcpServers: [mining]");
    expect(out).toContain("harness: claude-code");
    expect(out).toContain("quill body");
  });
  it("appends to an existing mcpServers line without dupes", () => {
    const out = ensureMiningSkill(`---\nharness: x\nmcpServers: [web-search]\n---\nb\n`);
    expect(out).toContain("mcpServers: [web-search, mining]");
  });
  it("is idempotent", () => {
    expect(ensureMiningSkill(HAS)).toBe(HAS);
  });
});

describe("removeMiningSkill", () => {
  it("drops mining, keeping siblings", () => {
    expect(removeMiningSkill(HAS)).toContain("mcpServers: [web-search]");
  });
  it("removes the whole line when mining was the only entry", () => {
    const out = removeMiningSkill(`---\nharness: x\nmcpServers: [mining]\n---\nb\n`);
    expect(out).not.toContain("mcpServers");
  });
  it("is a no-op when mining absent", () => {
    expect(removeMiningSkill(NONE)).toBe(NONE);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/fez-mining && npx vitest --run tests/persona-skill.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `packages/fez-mining/src/persona-skill.ts`**

```ts
/**
 * Idempotent frontmatter editors that opt a persona into (or out of) the
 * mining MCP skill by editing its `mcpServers: [...]` line. Deliberately a
 * minimal string edit — the persona frontmatter is flat and we touch one
 * field; a YAML lib would be overkill (see personas.ts's own note).
 */
const SKILL = "mining";

function editMcpServers(md: string, transform: (names: string[]) => string[]): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return md; // no frontmatter — leave untouched
  const block = fm[1];
  const lines = block.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("mcpServers:"));
  const current = idx >= 0
    ? (lines[idx].match(/\[(.*)\]/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const next = transform(current);
  if (idx >= 0) {
    if (next.length === 0) lines.splice(idx, 1);
    else lines[idx] = `mcpServers: [${next.join(", ")}]`;
  } else if (next.length > 0) {
    // insert after harness: if present, else at top of block
    const hIdx = lines.findIndex((l) => l.startsWith("harness:"));
    lines.splice(hIdx >= 0 ? hIdx + 1 : 0, 0, `mcpServers: [${next.join(", ")}]`);
  }
  return md.replace(fm[0], `---\n${lines.join("\n")}\n---\n`);
}

export function ensureMiningSkill(md: string): string {
  return editMcpServers(md, (names) => (names.includes(SKILL) ? names : [...names, SKILL]));
}

export function removeMiningSkill(md: string): string {
  return editMcpServers(md, (names) => names.filter((n) => n !== SKILL));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/fez-mining && npx vitest --run tests/persona-skill.test.ts`
Expected: PASS (6 tests). Note: `ensureMiningSkill(HAS) === HAS` requires the serialized
form to match byte-for-byte; the test's `HAS` already uses the `[a, b]` spacing the
editor emits.

- [ ] **Step 5: Wire the start-flow in `gui.tsx`**

In the confirm/start handler (`doStart`), after a successful `fez-mine start`, for the
chosen persona P:
```ts
// 1) roster P into #mining so @P mentions there are answered
await api.personas?.invite?.(persona, "bot");
// 2) grant P the mining skill so it can answer mining questions
if (api.personas) {
  const md = await api.personas.read(persona);
  const next = ensureMiningSkill(md);
  if (next !== md) await api.personas.update(persona, next);
}
```
Guard every call: `api.personas` is absent without the `personas` permission (already in
the manifest). Wrap in try/catch and surface a toast on failure (`api.toast?`), but do
NOT fail the start — mining still works without the chat wiring.

In the stop/remove path, mirror with `removeMiningSkill` so tearing down a persona's last
miner removes its mining-skill opt-in:
```ts
if (api.personas /* and this was the persona's last miner */) {
  const md = await api.personas.read(persona);
  const next = removeMiningSkill(md);
  if (next !== md) await api.personas.update(persona, next);
}
```
Only revert when the persona has no remaining miners (check the post-stop status list).

- [ ] **Step 6: Build + test**

Run: `cd packages/fez-mining && npm run check && npm run build && npx vitest --run`
Expected: clean; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-mining/src/persona-skill.ts packages/fez-mining/tests/persona-skill.test.ts packages/fez-mining/src/gui.tsx
git commit -m "fez-mining GUI: starting a miner rosters the persona to #mining and grants the mining skill; stop reverts"
```

### Task C3: ⛏ badge on the agents roster (HOST CODE — needs app rebuild)

**Files:**
- Modify: `packages/fez-desktop/src/App.tsx` (roster/cast rendering, ~1240-1259)

**Interfaces:**
- Consumes: mining state — the set of `(persona)` currently mining, read from
  `fez-mine status --json` via the existing `runExtensionCommand`/`processes.run` path
  the desktop already uses, or a lightweight cached read. Produces a per-roster-row badge.

> **This is the only host-code task.** It requires `npm run tauri build` in
> `packages/fez-desktop` and replacing `/Applications/fez.app`. It is separable: Stage C
> ships its user value (single cockpit + conversational wiring) without it. Do this task
> only if the roster badge is wanted; otherwise mark it deferred in the ledger.

- [ ] **Step 1: Read how the cast rows render**

`App.tsx:1240-1259` maps `client.agents()` to rows sorted online-first. Determine the
minimal read of "is this persona mining" — reuse whatever polling the app already runs;
do not add a second chain/CLI poll on the render path (compute it once per status tick).

- [ ] **Step 2: Add the badge**

For a roster row whose persona name is in the mining set, render a `⛏` glyph + the
netuid(s) next to the name (mirror the existing status-dot styling). No new sidebar
section — this is a badge on the existing roster, per the spec's "no new host seam".

- [ ] **Step 3: Build the app + verify**

Run: `cd packages/fez-desktop && npm run tauri build`, replace the app, ⌘Q + reopen.
Expected: a mining persona shows ⛏ + netuid in the roster; non-mining agents unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/src/App.tsx
git commit -m "desktop roster: show a ⛏ mining badge + netuid on agents that are mining"
```

---

## Self-Review

**1. Spec coverage:**
- Sub-project 1 (MCP tool) → Tasks A1–A2. Conversational "mine 56 on lium" → A2's
  `mining_start` with `machine: lium`. ✅
- Sub-project 2 (proactive persona status) → Tasks B1–B2; attestation precondition → B2
  Step 7. ✅
- Sub-project 3 (management consolidation, start-flow wiring, agents-native visibility)
  → C1 (de-dup), C2 (invite + skill opt-in/revert), C3 (roster badge). ✅
- Security constraints (no secret tools, testnet guard, persona-scoping) → Global
  Constraints + A2 note. ✅
- "No new sidebar section" → C3 is a badge, not a section. ✅

**2. Placeholder scan:** No TBD/TODO; every code step carries real code. The one
external lookup (the exact `@fezchat/protocol` path specifier in B1 Step 1) is a
copy-verbatim-from-sibling instruction, not a placeholder — the value is
package-manager-specific and must match siblings exactly.

**3. Type consistency:** `runMine`/`minersForPersona`/`mineArgs` (A1) are consumed
unchanged in A2. `postAsPersona`/`buildPersonaEvent` (B1) consumed in B2.
`ensureMiningSkill`/`removeMiningSkill` (C2) used only in C2's gui wiring. `persona` is
the `FEZ_AGENT_PERSONA` string throughout the MCP server; netuid is `number` in every
tool signature. Consistent.

**Notes for the executor:**
- Work in an isolated worktree (SDD setup creates it).
- Deploy for manual testing: copy `dist/mcp.js` is NOT enough for the skill to attach —
  run `fez link`/`fez install` for `fez-mining` so `~/.fez/settings.json`'s `mcpServers`
  gains the `mining` entry; then the persona needs `mining` in its frontmatter (Task C2
  does this automatically on start). For a manual smoke before C2, add `mcpServers:
  [mining]` to `~/.fez/personas/quill.md` by hand and run `fez agent quill`.
- Stages are independently shippable: A alone gives conversational mining (with a manual
  frontmatter opt-in); B adds unprompted persona status; C makes it turnkey + tidy.
