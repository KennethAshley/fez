# Wallet GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wallet extension grows a `gui` part — a consent inbox rendered under 💸 request messages (Approve ✅ / Decline ❌) and a Settings panel with live balances plus the spend ledger as a table — fed by one new generic core seam: read-only `api.storage` for GUI parts.

**Architecture:** Core gains a Tauri command that reads an extension's `~/.fez/extension-data/<name>.json` (name-validated) and the gui loader exposes it as `api.storage.get(key)` — the read half of the storage seam headless parts already have. The wallet CLI/MCP mirror their *public* state (addresses, endpoint, spend log) into that namespace. The gui part (`dist/gui.js`, browser IIFE like fez-git's) registers a message decorator for consent cards (approve = the owner's ✅ reaction via the shared client — the same event `awaitDecision` already trusts) and a settings panel querying finney over a webview WebSocket (`@polkadot/api` bundled for browser; CSP's `connect-src` already allows `wss:`).

**Tech Stack:** Rust/Tauri (one command), TypeScript (loader seam + wallet), `api.React.createElement` (no bundled React), `@polkadot/api` browser bundle, esbuild IIFE, vitest (wallet package tests).

**Spec:** `docs/superpowers/specs/2026-08-26-wallet-gui-design.md`

## Global Constraints

- Work in a fresh worktree branched from main (`git worktree add ../fez-wgui-wt -b wallet-gui`). Never commit files outside the plan's list; main hosts other agents' work.
- The storage seam is READ-ONLY for gui parts and namespace-locked: the loader passes the extension's own name; the Rust command validates `^[A-Za-z0-9][A-Za-z0-9._-]*$` and resolves only inside `~/.fez/extension-data/` (same traversal rigor as the wallet's entry-name policy).
- Nothing secret enters storage: addresses, endpoint, spend history only. The mnemonic/keys never appear in any file this plan touches.
- Approve/Decline publish ordinary owner reactions (`client.toggleReaction(channelId, msgId, "✅" | "❌")`) — no second consent mechanism, no new trust surface.
- The gui part uses `api.React.createElement` (aliased `h`) — never its own React; bundle `--format=iife --global-name=__fezExt --platform=browser` exactly like `packages/fez-git/package.json`'s gui build.
- Decorator match requires BOTH the 7666088 message shape (`💸` header + `react ✅` footer) AND `client.pkByName`-known local agent authorship.
- Top-up/fund stays CLI-only; gui storage writes stay CLI/MCP-only.
- Commits: plain messages, NO Claude co-author/session trailers.
- Verification commands: wallet tests `cd packages/fez-wallet && npm test`; desktop `cd packages/fez-desktop && npx tsc --noEmit`; Rust `cd packages/fez-desktop/src-tauri && cargo check`.

---

### Task 1: Core seam — `extension_storage_read` + gui `api.storage`

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (new command + `generate_handler!` registration at ~line 2147)
- Modify: `packages/fez-desktop/src/gui-extensions.ts` (api construction, ~line 683-744)
- Modify: `packages/fez-extension-api/src/gui.ts` (type)

**Interfaces:**
- Consumes: nothing new; mirrors `src/extensions/extension-storage.ts`'s file layout (one JSON object per extension at `~/.fez/extension-data/<name>.json`).
- Produces (Task 3 relies on): `api.storage: { get<T = unknown>(key: string): Promise<T | undefined> }` on `GuiExtensionApi`, namespace-locked to the calling extension's file stem; ungated by permission (matching the headless stance: "keep its own notes" isn't consent-worthy — reading them back isn't either).

- [ ] **Step 1: Rust command**

Add near the other read-only extension commands (after `list_gui_extensions`, ~line 410):

```rust
/// Read one extension's state file (~/.fez/extension-data/<name>.json)
/// whole, as text. The gui loader namespaces calls to the extension's
/// own stem — this command only enforces that the name can't traverse.
/// Read-only: gui parts render state; headless/CLI own writes.
#[tauri::command]
fn extension_storage_read(name: String) -> Result<String, String> {
    let ok_first = name
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let ok_rest = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok_first || !ok_rest || name.contains("..") {
        return Err(format!("invalid extension name: {name}"));
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let file = std::path::Path::new(&home)
        .join(".fez")
        .join("extension-data")
        .join(format!("{name}.json"));
    Ok(std::fs::read_to_string(file).unwrap_or_else(|_| "{}".to_string()))
}
```

Append `extension_storage_read` to `generate_handler![...]`.

- [ ] **Step 2: Loader seam**

In `packages/fez-desktop/src/gui-extensions.ts`, inside the per-extension `api` object (beside `client:`), add:

```ts
      // Read-only view of this extension's own state file — the gui
      // half of headless api.storage. Namespace-locked to `name` here;
      // the Rust command only re-checks the name can't traverse.
      storage: {
        get: async <T = unknown>(key: string): Promise<T | undefined> => {
          try {
            const raw = await invoke<string>("extension_storage_read", { name });
            const data = JSON.parse(raw) as Record<string, unknown>;
            return data[key] as T | undefined;
          } catch {
            return undefined;
          }
        },
      },
```

- [ ] **Step 3: Type it**

In `packages/fez-extension-api/src/gui.ts`, add to `GuiExtensionApi` (beside `client`):

```ts
  /**
   * Read-only view of this extension's own state file
   * (~/.fez/extension-data/<name>.json — the same namespace the
   * headless part's api.storage writes). Gui parts render state; the
   * CLI/MCP/headless side owns writes. Not permission-gated, matching
   * the headless stance.
   */
  storage: { get<T = unknown>(key: string): Promise<T | undefined> };
```

- [ ] **Step 4: Verify**

Run: `cd packages/fez-desktop/src-tauri && cargo check` — clean.
Run: `cd packages/fez-desktop && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src-tauri/src/lib.rs packages/fez-desktop/src/gui-extensions.ts packages/fez-extension-api/src/gui.ts
git commit -m "desktop: gui parts read their own extension storage — read-only api.storage seam"
```

---

### Task 2: Wallet storage mirror

**Files:**
- Create: `packages/fez-wallet/src/storage-mirror.ts`
- Modify: `packages/fez-wallet/src/cli-commands.ts` (init/derive/fund write mirror)
- Modify: `packages/fez-wallet/src/tools.ts` (walletSend mirrors log entries)
- Test: `packages/fez-wallet/tests/storage-mirror.test.ts`

**Interfaces:**
- Consumes: `SpendEntry` (`src/log.ts`), `WalletConfig` (`src/config.ts`).
- Produces (Task 3 reads these keys via `api.storage.get`):
  - storage file: `~/.fez/extension-data/${STORAGE_NAME}.json`
  - `STORAGE_NAME` — **must equal the gui part's installed file stem.** FIRST ACTION of this task: read `install_package`'s gui-part copy code (`packages/fez-desktop/src-tauri/src/lib.rs` ~line 880-890 — `("gui", "gui-extensions")`) and determine what stem `@fezchat/wallet`'s `dist/gui.js` lands as (package short-name? full name?). Set the constant to exactly that and record the finding in the task report.
  - key `addresses`: `{ treasury?: string; personas: Record<string, string> }`
  - key `endpoint`: `string` (the configured tao endpoint)
  - key `log`: `SpendEntry[]` (append, capped at last 500)
  - functions: `mirrorAddresses(update: { treasury?: string; persona?: { name: string; address: string } }): Promise<void>`, `mirrorEndpoint(endpoint: string): Promise<void>`, `mirrorSpend(entry: SpendEntry): Promise<void>` — all read-modify-write the single JSON object, dir override via `FEZ_EXTENSION_DATA_DIR` env (tests), silent no-throw on fs errors (mirroring must never break a send).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-mirror-"));
  process.env.FEZ_EXTENSION_DATA_DIR = dir;
});

async function readState() {
  const { STORAGE_NAME } = await import("../src/storage-mirror.js");
  return JSON.parse(fs.readFileSync(path.join(dir, `${STORAGE_NAME}.json`), "utf8"));
}

describe("storage mirror", () => {
  it("records treasury + persona addresses and endpoint", async () => {
    const { mirrorAddresses, mirrorEndpoint } = await import("../src/storage-mirror.js");
    await mirrorAddresses({ treasury: "5Treasury" });
    await mirrorAddresses({ persona: { name: "scout", address: "5Scout" } });
    await mirrorEndpoint("wss://test.finney.opentensor.ai:443");
    const s = await readState();
    expect(s.addresses).toEqual({ treasury: "5Treasury", personas: { scout: "5Scout" } });
    expect(s.endpoint).toBe("wss://test.finney.opentensor.ai:443");
  });

  it("appends spend entries and caps at 500", async () => {
    const { mirrorSpend } = await import("../src/storage-mirror.js");
    for (let i = 0; i < 502; i++) {
      await mirrorSpend({ ts: String(i), persona: "scout", to: "5X", amount: "0.001", asset: "TAO", txHash: `0x${i}`, consent: "auto" });
    }
    const s = await readState();
    expect(s.log).toHaveLength(500);
    expect(s.log[499].txHash).toBe("0x501");
    expect(s.log[0].txHash).toBe("0x2");
  });

  it("never throws on unwritable dir", async () => {
    process.env.FEZ_EXTENSION_DATA_DIR = "/dev/null/nope";
    const { mirrorSpend } = await import("../src/storage-mirror.js");
    await expect(
      mirrorSpend({ ts: "t", persona: "p", to: "x", amount: "1", asset: "TAO", txHash: "0x", consent: "auto" })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/storage-mirror.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `src/storage-mirror.ts`**

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SpendEntry } from "./log.js";

/**
 * Public wallet state mirrored into the extension-storage namespace
 * (~/.fez/extension-data/<STORAGE_NAME>.json) so the gui part — which
 * is webview-sandboxed and cannot read wallet.json or the jsonl log —
 * can render addresses, the endpoint, and the spend ledger via the
 * desktop's read-only api.storage seam.
 *
 * NOTHING SECRET LANDS HERE: addresses, endpoint, history — exactly
 * what the chain already shows. Writes are best-effort and silent: a
 * failed mirror must never break a transfer.
 */

// Must match the installed gui part's file stem in ~/.fez/gui-extensions
// (see install_package's ("gui","gui-extensions") copy in the desktop's
// lib.rs). Verified at implementation time.
export const STORAGE_NAME = "fez-wallet";

const MAX_LOG = 500;

function file(): string {
  const dir = process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data");
  return path.join(dir, `${STORAGE_NAME}.json`);
}

type State = {
  addresses?: { treasury?: string; personas?: Record<string, string> };
  endpoint?: string;
  log?: SpendEntry[];
  [k: string]: unknown;
};

let chain: Promise<unknown> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = chain.then(op, op).catch(() => {});
  chain = next;
  return next as Promise<void>;
}

async function update(mutate: (s: State) => void): Promise<void> {
  return enqueue(async () => {
    const f = file();
    let state: State = {};
    try {
      state = JSON.parse(await fs.readFile(f, "utf8"));
    } catch { /* missing/corrupt reads as empty */ }
    mutate(state);
    try {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(state, null, 2));
    } catch { /* best-effort — never break the caller */ }
  });
}

export function mirrorAddresses(u: { treasury?: string; persona?: { name: string; address: string } }): Promise<void> {
  return update((s) => {
    const a = (s.addresses ??= { personas: {} });
    a.personas ??= {};
    if (u.treasury) a.treasury = u.treasury;
    if (u.persona) a.personas[u.persona.name] = u.persona.address;
  });
}

export function mirrorEndpoint(endpoint: string): Promise<void> {
  return update((s) => {
    s.endpoint = endpoint;
  });
}

export function mirrorSpend(entry: SpendEntry): Promise<void> {
  return update((s) => {
    s.log = [...(s.log ?? []), entry].slice(-MAX_LOG);
  });
}
```

- [ ] **Step 4: Wire the writers**

`src/cli-commands.ts`: `cmdInit` mirrors the treasury address + config endpoint after printing; `cmdDerive` mirrors the persona address; `cmdFund` mirrors its transfer as a SpendEntry (`persona: "treasury"`, `consent: "auto"`). `src/tools.ts` `walletSend`: after `appendLog(...)`, `void mirrorSpend(sameEntry)` (fire-and-forget, and also mirror the endpoint once per process via a module-level flag — the panel needs it to pick the right chain). Imports at top of each file. All calls are `void`/awaited-but-silent per the mirror's contract.

- [ ] **Step 5: Run tests**

Run: `cd packages/fez-wallet && npm test` — all green (existing 51 + new 3). `npm run check` clean; `npm run build` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/storage-mirror.ts packages/fez-wallet/src/cli-commands.ts packages/fez-wallet/src/tools.ts packages/fez-wallet/tests/storage-mirror.test.ts
git commit -m "wallet: mirror public state (addresses, endpoint, spend log) into extension storage"
```

---

### Task 3: The gui part — consent cards + wallet panel

**Files:**
- Create: `packages/fez-wallet/src/gui-logic.ts` (pure, node-testable)
- Create: `packages/fez-wallet/src/gui.ts` (the part)
- Modify: `packages/fez-wallet/package.json` (parts.gui, permissions, build script, `@polkadot/api` already a dep, add `@fezchat/extension-api` devDep for types)
- Test: `packages/fez-wallet/tests/gui-logic.test.ts`

**Interfaces:**
- Consumes: Task 1's `api.storage.get`; Task 2's storage keys; `GuiExtensionApi` (`@fezchat/extension-api/gui`); `client.toggleReaction(channelId: string, targetId: string, emoji: string)` (fez-client:912); `client.pkByName(name)`; `client.messages(channelId)`.
- Produces: `dist/gui.js`; and from `gui-logic.ts`:
  - `parseConsentRequest(content: string): { persona: string; amount: string; to: string; memo?: string } | undefined` — matches the 7666088 three-line format (`💸 **<persona>** wants to send **<amount>**` / `` to `<addr>`[ — memo] `` / `react ✅ …`), undefined otherwise.
  - `requestStatus(reactions: { content: string; authorPk: string }[], ownerPk: string, msgTs: number, now: number): "pending" | "approved" | "declined" | "expired"` — owner ✅/`+` → approved, owner ❌/`-` → declined, else `now - msgTs > 600` → expired, else pending.

- [ ] **Step 1: Write the failing gui-logic tests**

```ts
import { describe, it, expect } from "vitest";
import { parseConsentRequest, requestStatus } from "../src/gui-logic.js";

const MSG = [
  "💸 **scout** wants to send **0.05 TAO**",
  "to `5E76cpgX…F7G7G4` — consent take two",
  "react ✅ to approve · ❌ to decline",
].join("\n");

describe("parseConsentRequest", () => {
  it("parses the shipped format", () => {
    expect(parseConsentRequest(MSG)).toEqual({
      persona: "scout",
      amount: "0.05 TAO",
      to: "5E76cpgX…F7G7G4",
      memo: "consent take two",
    });
  });
  it("parses without memo", () => {
    const noMemo = MSG.replace(" — consent take two", "");
    expect(parseConsentRequest(noMemo)?.memo).toBeUndefined();
  });
  it("rejects ordinary messages and near-misses", () => {
    expect(parseConsentRequest("hello 💸 world")).toBeUndefined();
    expect(parseConsentRequest("💸 **scout** wants to send **1 TAO**")).toBeUndefined(); // no footer
  });
});

describe("requestStatus", () => {
  const OWNER = "aa".repeat(32);
  it("owner ✅ approves; stranger ✅ doesn't", () => {
    expect(requestStatus([{ content: "✅", authorPk: OWNER }], OWNER, 0, 30)).toBe("approved");
    expect(requestStatus([{ content: "✅", authorPk: "bb".repeat(32) }], OWNER, 0, 30)).toBe("pending");
  });
  it("owner ❌ declines; stale pending expires", () => {
    expect(requestStatus([{ content: "❌", authorPk: OWNER }], OWNER, 0, 30)).toBe("declined");
    expect(requestStatus([], OWNER, 0, 601)).toBe("expired");
    expect(requestStatus([], OWNER, 0, 599)).toBe("pending");
  });
});
```

- [ ] **Step 2: Run to verify failure, implement `gui-logic.ts`**

```ts
/** Pure logic for the wallet gui part — node-testable, no React. */

export function parseConsentRequest(
  content: string
): { persona: string; amount: string; to: string; memo?: string } | undefined {
  const lines = content.split("\n");
  if (lines.length < 3) return undefined;
  const head = /^💸 \*\*(.+)\*\* wants to send \*\*(.+)\*\*$/.exec(lines[0]);
  const dest = /^to `([^`]+)`(?: — (.+))?$/.exec(lines[1]);
  if (!head || !dest || !lines[2].startsWith("react ✅")) return undefined;
  return { persona: head[1], amount: head[2], to: dest[1], ...(dest[2] ? { memo: dest[2] } : {}) };
}

const APPROVE = new Set(["✅", "+"]);
const DECLINE = new Set(["❌", "-"]);
const WINDOW_S = 600;

export function requestStatus(
  reactions: { content: string; authorPk: string }[],
  ownerPk: string,
  msgTs: number,
  now: number
): "pending" | "approved" | "declined" | "expired" {
  for (const r of reactions) {
    if (r.authorPk !== ownerPk) continue;
    if (APPROVE.has(r.content.trim())) return "approved";
    if (DECLINE.has(r.content.trim())) return "declined";
  }
  return now - msgTs > WINDOW_S ? "expired" : "pending";
}
```

Run: `cd packages/fez-wallet && npx vitest --run tests/gui-logic.test.ts` — PASS.

- [ ] **Step 3: Implement `src/gui.ts`**

Model on `packages/fez-git/src/gui.ts` (read its top 60 lines first for the h()/activate conventions). Structure:

```ts
import type { El, GuiExtensionApi } from "@fezchat/extension-api/gui";
import { parseConsentRequest, requestStatus } from "./gui-logic.js";

/**
 * fez-wallet, GUI part — the consent inbox and the treasury window.
 *
 * Approve/Decline publish the owner's ordinary ✅/❌ reaction — the
 * exact event the wallet's awaitDecision trusts. The buttons are
 * convenience, not a second consent mechanism. Balances are public
 * chain reads; addresses/endpoint/history come from the read-only
 * storage seam (the CLI/MCP wrote them there — the webview can't read
 * wallet.json and shouldn't).
 */

export default function activate(api: GuiExtensionApi): void {
  const h = api.React.createElement;
  const client = api.client;
  if (!client) return; // read:channels ungranted — nothing works without it

  // ── consent cards ────────────────────────────────────────────────
  api.registerMessageDecorator(
    (content) => parseConsentRequest(content) !== undefined,
    ({ content, msgId, channelId, authorName }) => {
      const req = parseConsentRequest(content);
      if (!req) return null as never;
      // Author must be a known local agent — cosmetics alone don't count.
      if (client.pkByName(req.persona) === undefined) return null as never;
      void authorName;
      const react = (emoji: string) => () => void client.toggleReaction(channelId, msgId, emoji);
      // Reactions/status: the client's reaction state isn't in the typed
      // GuiClient slice — read it via the real client (type against what
      // you use). Fall back to rendering plain buttons if unavailable.
      return h(
        "div",
        { style: { border: "1px solid var(--border, #333)", borderRadius: 8, padding: 10, marginTop: 6 } },
        h("div", { style: { fontWeight: 600 } }, `${req.persona} → ${req.amount}`),
        h("div", { style: { opacity: 0.8, fontSize: 12 } }, `to ${req.to}${req.memo ? ` — ${req.memo}` : ""}`),
        h(
          "div",
          { style: { marginTop: 8, display: "flex", gap: 8 } },
          h("button", { onClick: react("✅") }, "Approve ✅"),
          h("button", { onClick: react("❌") }, "Decline ❌")
        )
      );
    }
  );

  // ── wallet panel ─────────────────────────────────────────────────
  api.registerSettingsPanel("Wallet", () => h(WalletPanel, { api } as never));

  function WalletPanel({ api }: { api: GuiExtensionApi }): El {
    const { useState, useEffect } = api.React;
    const [addresses, setAddresses] = useState<{ treasury?: string; personas?: Record<string, string> }>({});
    const [endpoint, setEndpoint] = useState<string | undefined>(undefined);
    const [log, setLog] = useState<unknown[]>([]);
    const [balances, setBalances] = useState<Record<string, string>>({});

    useEffect(() => {
      void (async () => {
        setAddresses((await api.storage.get("addresses")) ?? {});
        setEndpoint(await api.storage.get("endpoint"));
        setLog(((await api.storage.get("log")) as unknown[]) ?? []);
      })();
    }, []);

    useEffect(() => {
      if (!endpoint) return;
      let dead = false;
      void (async () => {
        const { ApiPromise, WsProvider } = await import("@polkadot/api");
        const chain = await ApiPromise.create({ provider: new WsProvider(endpoint), noInitWarn: true });
        const rows: [string, string][] = [
          ...(addresses.treasury ? ([["treasury", addresses.treasury]] as [string, string][]) : []),
          ...Object.entries(addresses.personas ?? {}),
        ];
        for (const [who, addr] of rows) {
          const acct = (await chain.query.system.account(addr)) as { data: { free: { toBigInt(): bigint } } };
          if (dead) break;
          const raw = acct.data.free.toBigInt();
          const whole = raw / 1_000_000_000n;
          const frac = (raw % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
          setBalances((b) => ({ ...b, [who]: `${whole}${frac ? "." + frac : ""} TAO` }));
        }
        void chain.disconnect();
      })().catch(() => {});
      return () => {
        dead = true;
      };
    }, [endpoint, JSON.stringify(addresses)]);

    // Rendering: balances list, then the ledger table.
    // (Full JSX-free table markup — thead: time/agent/amount/to/memo/consent/tx,
    // tbody mapping `log` newest-first, tx cell = api.openUrl(taostats link).)
    ...
  }
}
```

The `...` above is the ledger table markup — write it out with `h("table", …)`, columns exactly `time · agent · amount · to · memo · consent · tx`, rows from `log` reversed, `to` shortened `slice(0,8)+…`, tx cell a link-styled button calling `api.openUrl(\`https://taostats.io/transfer/${txHash}\`)`. Empty log renders "no transfers yet". No placeholder is acceptable in the committed file — the plan elides only this table literal for brevity; everything else above is verbatim.

Reactions-for-status: check the real `client` for a reaction accessor (grep fez-client for `reactions` near `handleReaction`); if a per-message reaction list is exposed, thread it into `requestStatus` and render the resolved state instead of buttons; if none is exposed, render buttons always (idempotent — a second ✅ is a toggle; note it in the report and ledger as a deferred polish).

- [ ] **Step 4: Manifest + build**

`packages/fez-wallet/package.json`:
- `fez.parts.gui: "dist/gui.js"`
- permissions: add `"read:channels"`, `"ui"` (keep the existing three)
- build script: append `&& esbuild src/gui.ts --bundle --format=iife --global-name=__fezExt --platform=browser --outfile=dist/gui.js` (mirroring fez-git; `@polkadot/api` bundles for browser)
- devDependencies: `"@fezchat/extension-api": "file:../fez-extension-api"` (check how fez-git declares it and match exactly).

- [ ] **Step 5: Verify**

Run: `cd packages/fez-wallet && npm install && npm test` (all green) `&& npm run check && npm run build` — `dist/gui.js` exists; note its size in the report (the @polkadot/api browser bundle is expected to be MBs — acceptable, flag if >8MB).

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/gui-logic.ts packages/fez-wallet/src/gui.ts packages/fez-wallet/package.json packages/fez-wallet/package-lock.json packages/fez-wallet/tests/gui-logic.test.ts
git commit -m "wallet: gui part — consent cards in chat, balances + spend ledger panel"
```

---

### Task 4: Link, smoke, README

**Files:**
- Modify: `packages/fez-wallet/README.md`

- [ ] **Step 1: Manual link + smoke (document results in the report)**

From the worktree: place the gui part exactly as install would — copy `packages/fez-wallet/dist/gui.js` to `~/.fez/gui-extensions/<STORAGE_NAME>.js` (the stem Task 2 verified). Confirm `~/.fez/extension-data/<STORAGE_NAME>.json` exists from the earlier testnet run (it will after any `fez-wallet status`/`derive` on the new build — run `node packages/fez-wallet/dist/cli.js status` once to trigger mirroring). Note for Ken's manual pass: relaunch the desktop app → Settings shows a "Wallet" card with balances + table; a 💸 message in #general grows Approve/Decline buttons. (Automated UI verification is out of scope; the desktop has no webview test harness — the smoke is human.)

- [ ] **Step 2: README section**

Append to `packages/fez-wallet/README.md`:

```markdown
## GUI

The extension ships a gui part: consent requests in chat grow
Approve ✅ / Decline ❌ buttons (they publish your ordinary reaction —
the same event the wallet trusts), and Settings gains a Wallet card
with live balances and the spend ledger. The panel reads only the
public state the CLI mirrors into extension storage (addresses,
endpoint, history) — keys never touch the webview. Ceremony (init/
derive/fund) remains CLI-only by design.
```

- [ ] **Step 3: Full verification sweep**

```bash
cd packages/fez-wallet && npm test && npm run check && npm run build
cd ../fez-desktop && npx tsc --noEmit
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add packages/fez-wallet/README.md
git commit -m "wallet: README — gui part (consent cards, wallet panel)"
```
