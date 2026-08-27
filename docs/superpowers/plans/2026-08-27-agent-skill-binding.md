# Agent ↔ Skill Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a skill an agent declares resolve to a *package* rather than a key in the local settings file, and give the GUI three places to attach one — so a GUI-only user never types a skill name from memory.

**Architecture:** Three optional metadata fields (`package`, `source`, `description`) are recorded in each `~/.fez/settings.json` `mcpServers` entry at install/link time. A new pure resolver matches a persona's declared skill against that catalog by key → source → package, so bare names keep working and a package found under a different local name still resolves. On top of that, the desktop gains a skill picker (agent editor), a "give to" control (skill row), and an attach offer (install dialog) — all three calling one shared pure module. Finally, dead references and dev-tree skills become visible next to the agent instead of being console warnings.

**Tech Stack:** TypeScript, ESM, vitest (`packages/fez-evals/tests`), React 18 + Tauri v2 (`packages/fez-desktop`), Rust (Tauri commands — read only, none added).

**Spec:** `docs/superpowers/specs/2026-08-27-agent-skill-binding-design.md`

## Global Constraints

- **`skill-source.ts` is mirrored and the mirror is test-enforced.** The canonical Node implementation is `src/extensions/skill-source.ts`; the browser-safe copy is `packages/fez-client/src/skill-source.ts`. `packages/fez-evals/tests/skill-source.test.ts` runs **both** over one case table and fails on any disagreement. Every function added in Task 1 must be added to **both files, with identical behaviour**.
- **No new Tauri command.** `read_skills` already returns the raw `mcpServers` JSON and `config-store.ts` exposes it as `useConfig().skills`. New fields ride along in that same JSON; only TypeScript types widen.
- **Never store a `local` flag.** The spec proposed one; `machineLocalPath(config)` already derives it from the entry's args and the GUI already uses it (`SkillsView.tsx:274,449`). Storing it would be a second source of truth. **This is a deliberate departure from the spec.**
- **Persona writes go through `formatSkillEntries`.** Never hand-build the `mcpServers:` line — `formatSkillEntries(names, sources)` preserves the `name=source` form.
- **Persona files are round-tripped, not regenerated.** Unknown frontmatter keys and hand-written formatting must survive every write (the existing `PersonaEditor` contract).
- **Desktop pure logic lives outside React.** Follow the established pattern: logic in a plain `packages/fez-desktop/src/*.ts` module, tested from `packages/fez-evals/tests/*.test.ts` via `import { … } from "../../fez-desktop/src/<mod>.js"`. React components stay thin. (`onboarding-steps.ts` and `fez-wallet/src/gui-logic.ts` are the references.)
- **Test command:** `npm test --prefix packages/fez-evals` (vitest). A single file: `npm test --prefix packages/fez-evals -- <name>.test.ts`.
- **`packages/fez-client` must be built before evals run** — the parity test imports `../../fez-client/dist/index.js`. Build with `npm run build --prefix packages/fez-client`.
- **Seeing desktop changes requires a Tauri rebuild** and swapping the app into `/Applications`. Not needed for any test in this plan; needed for manual verification at the end.
- **Work in the worktree:** `/Users/ken/Projects/fez/.worktrees/skill-binding`, branch `skill-binding`.

---

### Task 1: The resolver

The one piece of new logic. Given the machine catalog and what a persona declared, find the matching entry — by key, then by source spec, then by package.

**Files:**
- Modify: `src/extensions/skill-source.ts` (add ~40 lines after `wellKnownSource`, ends line 132)
- Modify: `packages/fez-client/src/skill-source.ts` (identical additions)
- Test: `packages/fez-evals/tests/skill-source.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `SkillSpec` (already exported from both files), the `PACKAGE` regex (already defined in both, module-private)
- Produces:
  - `interface SkillEntry extends SkillSpec { package?: string; source?: string; description?: string }`
  - `packageFromSource(source: string | undefined): string | undefined`
  - `resolveInstalledSkill(catalog: Record<string, SkillEntry>, declared: { name: string; source?: string }): { key: string; entry: SkillEntry } | undefined`

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-evals/tests/skill-source.test.ts`. Note the file already imports from both implementations — add the new names to both import lists at the top (`@fezchat/protocol` and `mirror`).

```ts
describe("resolving a declared skill against the machine catalog", () => {
  // The catalog a machine ends up with depends on how things were
  // installed: `fez install npm:@fezchat/wallet` writes the key
  // "wallet", `fez link packages/fez-wallet` writes "fez-wallet".
  const catalog = {
    "fez-wallet": {
      command: "node",
      args: ["/Users/someone/Projects/fez/packages/fez-wallet/dist/mcp.js"],
      package: "@fezchat/wallet",
      source: "npm:@fezchat/wallet",
    },
    "web-search": {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      package: "@brave/brave-search-mcp-server",
      source: "npm:@brave/brave-search-mcp-server",
    },
    // A hand-rolled skill: `fez skill add`, no package behind it.
    scratch: { command: "node", args: ["/opt/scratch/mcp.js"] },
  };

  for (const [label, impl] of [["protocol", proto], ["mirror", mirror]] as const) {
    describe(label, () => {
      test("an exact key match wins, even with no metadata", () => {
        expect(impl.resolveInstalledSkill(catalog, { name: "scratch" })?.key).toBe("scratch");
      });

      test("the local key wins over a package match", () => {
        // Both could match; step 1 must not be skipped.
        expect(
          impl.resolveInstalledSkill(catalog, { name: "web-search", source: "npm:@fezchat/wallet" })?.key
        ).toBe("web-search");
      });

      test("THE BUG: a package installed under a different local name still resolves", () => {
        // @scout declares `wallet=npm:@fezchat/wallet`; this machine
        // linked it, so the key is "fez-wallet". Before this resolver
        // that was a silent miss.
        expect(
          impl.resolveInstalledSkill(catalog, { name: "wallet", source: "npm:@fezchat/wallet" })?.key
        ).toBe("fez-wallet");
      });

      test("a bare name that matches nothing stays unresolved", () => {
        expect(impl.resolveInstalledSkill(catalog, { name: "github" })).toBeUndefined();
      });

      test("a declared source for something not installed stays unresolved", () => {
        expect(
          impl.resolveInstalledSkill(catalog, { name: "obsidian", source: "npm:@fezchat/obsidian" })
        ).toBeUndefined();
      });

      test("packageFromSource reads the package out of every runner scheme", () => {
        expect(impl.packageFromSource("npm:@fezchat/wallet")).toBe("@fezchat/wallet");
        expect(impl.packageFromSource("uvx:browser-use-mcp")).toBe("browser-use-mcp");
        expect(impl.packageFromSource("pipx:mcp-server-git")).toBe("mcp-server-git");
      });

      test("a url has no package name — identity is the url, matched at step 2", () => {
        expect(impl.packageFromSource("https://mcp.example.com/sse")).toBeUndefined();
        expect(impl.packageFromSource(undefined)).toBeUndefined();
      });

      test("a malformed package name is refused, not passed to a runner", () => {
        expect(impl.packageFromSource("npm:../../etc/passwd")).toBeUndefined();
        expect(impl.packageFromSource("npm:-rf")).toBeUndefined();
      });
    });
  }
});
```

Add to the existing top-of-file imports:

```ts
import {
  parseSkillSource,
  // …existing names…
  resolveInstalledSkill,
  packageFromSource,
} from "@fezchat/protocol";
import * as proto from "@fezchat/protocol";
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build --prefix packages/fez-client
npm test --prefix packages/fez-evals -- skill-source.test.ts
```
Expected: FAIL — `resolveInstalledSkill is not a function`.

- [ ] **Step 3: Implement in `src/extensions/skill-source.ts`**

Insert after `wellKnownSource` (currently ends line 132):

```ts
/**
 * A settings.json mcpServers entry, plus the provenance recorded at
 * install time. All three extra fields are optional: a hand-rolled
 * skill (`fez skill add --command …`) has none of them and stays a
 * first-class citizen — local names are a category, not a legacy.
 */
export interface SkillEntry extends SkillSpec {
  /** Canonical id, from the installed package's own package.json name. */
  package?: string;
  /** The spec that reinstalls it — feeds the `name=source` form. */
  source?: string;
  /** One line for a picker. */
  description?: string;
}

/**
 * The package a source spec names, or undefined when it doesn't name one.
 *
 * Runs the same PACKAGE grammar the runners do, so a spec that would be
 * refused at install can never match an installed entry here either —
 * otherwise `npm:../../etc/passwd` could alias its way onto a real skill.
 * A url names no package; its identity IS the url, matched at step 2.
 */
export function packageFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  for (const scheme of ["npm:", "uvx:", "pipx:"]) {
    if (source.startsWith(scheme)) {
      const pkg = source.slice(scheme.length);
      return PACKAGE.test(pkg) ? pkg : undefined;
    }
  }
  return undefined;
}

/**
 * Find the catalog entry a declared skill means. Trust order:
 *
 *  1. the LOCAL KEY — this machine's own answer for that name, already
 *     approved by a human. Never overridden by a package match.
 *  2. the declared SOURCE, matched verbatim — covers hosted (url) skills,
 *     which name no package.
 *  3. the PACKAGE the source names — the fix. `fez install
 *     npm:@fezchat/wallet` keys it "wallet" and `fez link` keys it
 *     "fez-wallet"; a persona declaring either source resolves to
 *     whichever one this machine happens to have.
 *
 * Undefined means genuinely not installed. The caller reports the gap;
 * it never installs on the persona's say-so.
 */
export function resolveInstalledSkill(
  catalog: Record<string, SkillEntry>,
  declared: { name: string; source?: string }
): { key: string; entry: SkillEntry } | undefined {
  const direct = catalog[declared.name];
  if (direct) return { key: declared.name, entry: direct };
  if (!declared.source) return undefined;

  for (const [key, entry] of Object.entries(catalog)) {
    if (entry.source && entry.source === declared.source) return { key, entry };
  }
  const pkg = packageFromSource(declared.source);
  if (!pkg) return undefined;
  for (const [key, entry] of Object.entries(catalog)) {
    if (entry.package && entry.package === pkg) return { key, entry };
  }
  return undefined;
}
```

- [ ] **Step 4: Mirror it into `packages/fez-client/src/skill-source.ts`**

Paste the identical block (interface + both functions) into the browser mirror. The mirror has its own `PACKAGE` regex and `SkillSpec` — do not import across the boundary; the file is browser-safe by being self-contained.

- [ ] **Step 5: Export from both barrels — they behave differently**

`packages/fez-client/src/index.ts:428` is `export * from "./skill-source.js"` — the mirror's new names are exported automatically, nothing to do.

`src/index.ts:63` is an explicit **named list** and will silently omit anything you don't add. Replace that line with:

```ts
export { parseSkillSource, describeSkillSpec, wellKnownSource, installHint, machineLocalPath, resolveInstalledSkill, packageFromSource, SOURCE_SCHEMES, type SkillSpec, type SkillEntry } from "./extensions/skill-source.js";
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npm run build --prefix packages/fez-client
npm test --prefix packages/fez-evals -- skill-source.test.ts
```
Expected: PASS, both `protocol` and `mirror` describe blocks.

- [ ] **Step 7: Commit**

```bash
git add src/extensions/skill-source.ts packages/fez-client/src/skill-source.ts packages/fez-evals/tests/skill-source.test.ts
git commit -m "skills: resolve a declared skill by package, not just by local key

fez install npm:@fezchat/wallet keys the catalog 'wallet'; fez link
packages/fez-wallet keys it 'fez-wallet'. Same package, two names, and a
persona naming the wrong one missed silently. resolveInstalledSkill
tries the local key first (a human already approved that name), then the
declared source verbatim (hosted skills name no package), then the
package the source names."
```

---

### Task 2: Record provenance at install and link

**Files:**
- Modify: `src/extensions/package-manager.ts` — `FezManifest` (line 32), `installParts` signature (line 664) and its skill block (lines 720-731), call site (line 461)
- Modify: `src/cli/cmd-extensions.ts:275-289` (the `fez link` skill block)
- Test: `packages/fez-evals/tests/skill-provenance.test.ts` (create)

**Interfaces:**
- Consumes: `SkillEntry` from Task 1
- Produces: `skillEntryFor(part, opts): SkillEntry` exported from `src/extensions/package-manager.ts` — the one place that decides what gets written into `mcpServers`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-evals/tests/skill-provenance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { skillEntryFor } from "@fezchat/protocol";

/**
 * What an install writes into settings.json. The point of the extra
 * fields is that the SAME package produces the same `package` value
 * however it arrived — that's what lets a persona find it under a
 * different local key.
 */
describe("skill provenance recorded at install", () => {
  const part = { command: "node", args: ["/abs/path/dist/mcp.js"] };

  it("records package and description from the manifest", () => {
    expect(
      skillEntryFor(part, { manifestName: "@fezchat/wallet", description: "pay and receive TAO", source: "npm:@fezchat/wallet" })
    ).toEqual({
      command: "node",
      args: ["/abs/path/dist/mcp.js"],
      package: "@fezchat/wallet",
      source: "npm:@fezchat/wallet",
      description: "pay and receive TAO",
    });
  });

  it("a linked package records its package but no source — there is no spec that fetches it", () => {
    expect(skillEntryFor(part, { manifestName: "@fezchat/wallet", description: "pay and receive TAO" })).toEqual({
      command: "node",
      args: ["/abs/path/dist/mcp.js"],
      package: "@fezchat/wallet",
      description: "pay and receive TAO",
    });
  });

  it("omits fields rather than writing empty ones — a hand-rolled skill stays clean", () => {
    expect(skillEntryFor(part, {})).toEqual({ command: "node", args: ["/abs/path/dist/mcp.js"] });
  });

  it("keeps env the caller merged in", () => {
    expect(skillEntryFor({ ...part, env: { TOKEN: "x" } }, { manifestName: "pkg" })).toEqual({
      command: "node",
      args: ["/abs/path/dist/mcp.js"],
      env: { TOKEN: "x" },
      package: "pkg",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --prefix packages/fez-evals -- skill-provenance.test.ts
```
Expected: FAIL — `skillEntryFor is not a function`.

- [ ] **Step 3: Add `skillEntryFor` to `src/extensions/package-manager.ts`**

Add near `resolveSkillArgs` (around line 136), and export it:

```ts
/**
 * The one place that decides what an install writes into
 * settings.json's mcpServers. Provenance is what makes a persona
 * portable: `package` is the canonical id (identical on every machine
 * however the package arrived), `source` is the spec that refetches it,
 * `description` is what a picker renders.
 *
 * Every field is omitted rather than written empty — a hand-rolled
 * skill's entry must stay exactly as small as it was.
 */
export function skillEntryFor(
  spec: SkillSpec & { env?: Record<string, string> },
  opts: { manifestName?: string; description?: string; source?: string }
): SkillEntry {
  return {
    ...spec,
    ...(opts.manifestName ? { package: opts.manifestName } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}
```

Add the imports at the top of the file:

```ts
import { type SkillEntry, type SkillSpec } from "./skill-source.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --prefix packages/fez-evals -- skill-provenance.test.ts
```
Expected: PASS.

- [ ] **Step 5: Widen `FezManifest` to carry the npm fields**

In `src/extensions/package-manager.ts`, add to `interface FezManifest` (line 32), above `bin`:

```ts
  /** package.json's own name/description — used to record skill provenance. */
  name?: string;
  description?: string;
```

- [ ] **Step 6: Use it in `installParts`**

Change the signature (line 664) to take the manifest facts it now needs:

```ts
  private async installParts(
    name: string,
    parts: {
      skill?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
      headless?: string;
      gui?: string;
      relay?: string;
      workspace?: string;
      background?: boolean;
    },
    provenance: { manifestName?: string; description?: string; source?: string } = {}
  ): Promise<void> {
```

Replace the skill block (lines 720-731) with:

```ts
    if (parts.skill) {
      const settings = this.settings.load() as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      // keep env VALUES the user already filled in; the package supplies names
      const mergedEnv = { ...(parts.skill.env ?? {}), ...(settings.mcpServers?.[name]?.env ?? {}) };
      this.settings.save({
        mcpServers: {
          ...settings.mcpServers,
          [name]: skillEntryFor(
            { ...resolveSkillArgs(parts.skill, pkgDir), ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) },
            provenance
          ),
        },
      });
      console.log(chalk.dim(`   Defined skill "${name}" in ~/.fez/settings.json`));
    }
```

Update the call site (line 461):

```ts
    if (manifest.fez.parts) {
      await this.installParts(name, manifest.fez.parts, {
        manifestName: manifest.name,
        description: manifest.description,
        // pkg.source is the resolved spec — "npm:@fezchat/wallet". A git
        // install has no runner scheme, so it records no source and
        // resolves by package alone.
        source: pkg.source?.startsWith("npm:") ? pkg.source : undefined,
      });
    }
```

- [ ] **Step 7: Use it in `fez link`**

In `src/cli/cmd-extensions.ts`, replace the `saveSettings` call in the skill block (lines 281-288) with:

```ts
      const { skillEntryFor } = await import("../extensions/package-manager.js");
      saveSettings({
        mcpServers: {
          ...settings.mcpServers,
          // Relative args ("dist/mcp.js") resolve against the LINKED dir —
          // same rule as install, or the spawner has no way to find them.
          // No `source`: a linked directory is not a spec anyone can fetch.
          [name]: skillEntryFor(
            { ...resolveSkillArgs(parts.skill, pkgDir), ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) },
            { manifestName: manifest.name, description: manifest.description }
          ),
        },
      } as never);
```

- [ ] **Step 8: Verify the whole suite still passes**

```bash
npm test --prefix packages/fez-evals
```
Expected: PASS, no regressions (the persona-pack and skill-source suites both touch this code).

- [ ] **Step 9: Commit**

```bash
git add src/extensions/package-manager.ts src/cli/cmd-extensions.ts packages/fez-evals/tests/skill-provenance.test.ts
git commit -m "skills: an installed skill records which package it is

A settings entry knew how to RUN something and not what it was. Install
and link now record package (canonical id, same on every machine),
source (the spec that refetches it) and description (what a picker
shows). Every field is omitted rather than written empty, so a
hand-rolled 'fez skill add' entry stays exactly as small as it was."
```

---

### Task 3: Spawn resolves by package

**Files:**
- Modify: `src/extensions/mcp-servers.ts` — `loadMcpServersFromSettings` (line ~175) and a new `findMcpServerForDeclared`
- Modify: `packages/fez-acp/src/agent.ts:210-224` (missing-skill computation and `mcpServers` build)
- Test: `packages/fez-evals/tests/skill-resolve-spawn.test.ts` (create)

**Interfaces:**
- Consumes: `resolveInstalledSkill` (Task 1); `SkillEntry` (Task 1)
- Produces: `resolveDeclaredSkills(catalog, declared): { resolved: {name,key,entry}[]; missing: {name,source?}[] }` exported from `src/extensions/mcp-servers.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-evals/tests/skill-resolve-spawn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveDeclaredSkills } from "@fezchat/protocol";

/**
 * The spawn-time split: which declared skills this machine can actually
 * provide, and which are gaps the agent must disclose. Live case — the
 * author's @scout declares `mcpServers: [bittensor, fez-wallet]` while
 * @researcher declares a `github` that was never installed.
 */
describe("resolving a persona's declared skills at spawn", () => {
  const catalog = {
    "fez-wallet": { command: "node", args: ["/x/mcp.js"], package: "@fezchat/wallet", source: "npm:@fezchat/wallet" },
    bittensor: { command: "node", args: ["/y/mcp.js"], package: "@fezchat/bittensor" },
  };

  it("splits resolved from missing", () => {
    const out = resolveDeclaredSkills(catalog, [
      { name: "bittensor" },
      { name: "github" },
    ]);
    expect(out.resolved.map((r) => r.name)).toEqual(["bittensor"]);
    expect(out.missing).toEqual([{ name: "github", source: undefined }]);
  });

  it("a persona naming the package resolves against a differently-keyed entry", () => {
    const out = resolveDeclaredSkills(catalog, [{ name: "wallet", source: "npm:@fezchat/wallet" }]);
    expect(out.missing).toEqual([]);
    expect(out.resolved[0].key).toBe("fez-wallet");
    // The NAME the agent sees is what the persona declared, not the
    // local key — the prompt and the ACP session must not leak this
    // machine's filing system.
    expect(out.resolved[0].name).toBe("wallet");
  });

  it("preserves the declared source on a miss, so the caller can print an install hint", () => {
    const out = resolveDeclaredSkills(catalog, [{ name: "obsidian", source: "npm:@fezchat/obsidian" }]);
    expect(out.missing).toEqual([{ name: "obsidian", source: "npm:@fezchat/obsidian" }]);
  });

  it("an empty declaration list resolves to nothing, not an error", () => {
    expect(resolveDeclaredSkills(catalog, [])).toEqual({ resolved: [], missing: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --prefix packages/fez-evals -- skill-resolve-spawn.test.ts
```
Expected: FAIL — `resolveDeclaredSkills is not a function`.

- [ ] **Step 3: Implement in `src/extensions/mcp-servers.ts`**

Add at the end of the file, plus the import at the top:

```ts
import { resolveInstalledSkill, type SkillEntry } from "./skill-source.js";

/**
 * Split what a persona declared into what this machine can provide and
 * what it can't. The gap is returned rather than swallowed: a spawn
 * proceeds without the skill and the agent is told to say so, which is
 * the honest failure mode — a confidently wrong answer is the bad one.
 *
 * `name` on a resolved entry is what the PERSONA declared, never the
 * local catalog key. The agent's tool namespace is the persona's
 * vocabulary; this machine's filing system stays private to it.
 */
export function resolveDeclaredSkills(
  catalog: Record<string, SkillEntry>,
  declared: { name: string; source?: string }[]
): {
  resolved: { name: string; key: string; entry: SkillEntry }[];
  missing: { name: string; source?: string }[];
} {
  const resolved: { name: string; key: string; entry: SkillEntry }[] = [];
  const missing: { name: string; source?: string }[] = [];
  for (const decl of declared) {
    const hit = resolveInstalledSkill(catalog, decl);
    if (hit) resolved.push({ name: decl.name, key: hit.key, entry: hit.entry });
    else missing.push({ name: decl.name, source: decl.source });
  }
  return { resolved, missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --prefix packages/fez-evals -- skill-resolve-spawn.test.ts
```
Expected: PASS.

- [ ] **Step 5: Wire it into the spawn path**

In `packages/fez-acp/src/agent.ts`, replace the `missingSkills` / `mcpServers` block (lines 210-224) with:

```ts
  const declared = persona.mcpServers.map((name) => ({ name, source: persona.mcpSources?.[name] }));
  const catalog = (() => {
    try {
      const proto = require("@fezchat/protocol") as { loadSettings: () => { mcpServers?: Record<string, never> } };
      return proto.loadSettings().mcpServers ?? {};
    } catch {
      return {};
    }
  })();
  const { resolved, missing } = resolveDeclaredSkills(catalog, declared);
  const missingSkills = missing.map((m) => m.name);
  if (missing.length > 0) {
    // Declaring a source does NOT install it — a persona file arrives
    // from whoever wrote it, and running what it names would make
    // installing a persona arbitrary code execution. So we print the
    // one-line install and carry on without the skill.
    console.warn(`⚠️  Skills declared but not loadable here — the agent will disclose the gap when relevant:`);
    for (const m of missing) {
      console.warn(`   ${installHint(m.name, m.source ?? wellKnownSource(m.name))}`);
    }
  }
  const mcpServers = resolved
    .map((r) => findMcpServer(r.key))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
```

Keep the existing `loadMcpServersFromSettings` call above it unchanged — the registry still keys servers by their catalog key, which is why `findMcpServer(r.key)` (not `r.name`) is correct.

Update the wire-profile line (currently `agent.ts:709`) to use the resolved list, so the router advertises the persona's names:

```ts
        skills: resolved.map((r) => r.name),
```

- [ ] **Step 6: Typecheck**

```bash
npm run check --prefix packages/fez-acp 2>/dev/null || npx tsc --noEmit -p packages/fez-acp
```
Expected: no errors.

- [ ] **Step 7: Run the whole suite**

```bash
npm test --prefix packages/fez-evals
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/extensions/mcp-servers.ts packages/fez-acp/src/agent.ts packages/fez-evals/tests/skill-resolve-spawn.test.ts
git commit -m "spawn: resolve declared skills through the package matcher

The tool name an agent sees is what its PERSONA declared; the catalog
key stays private to this machine. A persona that says
wallet=npm:@fezchat/wallet now finds the entry whether the local install
keyed it 'wallet' or 'fez-wallet'."
```

---

### Task 4: Shared attach/detach logic for the GUI

Pure module, no React. All three surfaces in Tasks 5-7 call it.

**Files:**
- Create: `packages/fez-desktop/src/skill-attach.ts`
- Modify: `packages/fez-desktop/src/config-store.ts:18` (widen the `skills` type)
- Test: `packages/fez-evals/tests/skill-attach.test.ts` (create)

**Interfaces:**
- Consumes: `parseSkillEntries`, `formatSkillEntries` from `@fezchat/client`; `SkillEntry` from Task 1
- Produces:
  - `attachSkill(content: string, skill: string, source?: string): string | undefined`
  - `detachSkill(content: string, skill: string): string | undefined`
  - `declaredSkills(content: string): { name: string; source?: string }[]`
  - Each returns `undefined` when the file needs no change or can't be parsed — callers skip the write.

- [ ] **Step 1: Write the failing test**

Create `packages/fez-evals/tests/skill-attach.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { attachSkill, detachSkill, declaredSkills } from "../../fez-desktop/src/skill-attach.js";

const persona = `---
harness: claude-code
owner: 4d9a4f80
aliases: [subnets, bittensor]
mcpServers: [bittensor, fez-wallet]
description: your Bittensor scout
---
You are @scout.
`;

describe("editing a persona's declared skills", () => {
  it("reads what is declared, with sources", () => {
    expect(declaredSkills(persona)).toEqual([
      { name: "bittensor", source: undefined },
      { name: "fez-wallet", source: undefined },
    ]);
  });

  it("attaches in the portable form", () => {
    const out = attachSkill(persona, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [bittensor, fez-wallet, wallet=npm:@fezchat/wallet]");
  });

  it("attaches a source-less skill as a bare name", () => {
    expect(attachSkill(persona, "scratch")!).toContain("mcpServers: [bittensor, fez-wallet, scratch]");
  });

  it("leaves every other line untouched", () => {
    const out = attachSkill(persona, "polls", "npm:@fezchat/polls")!;
    expect(out).toContain("aliases: [subnets, bittensor]");
    expect(out).toContain("owner: 4d9a4f80");
    expect(out).toContain("You are @scout.");
    // Unknown/extension keys and the body must survive verbatim.
    expect(out.split("\n").length).toBe(persona.split("\n").length);
  });

  it("attaching something already declared changes nothing", () => {
    expect(attachSkill(persona, "bittensor")).toBeUndefined();
  });

  it("detaches, preserving the sources of the survivors", () => {
    const withSource = persona.replace("fez-wallet]", "fez-wallet=npm:@fezchat/wallet]");
    const out = detachSkill(withSource, "bittensor")!;
    expect(out).toContain("mcpServers: [fez-wallet=npm:@fezchat/wallet]");
  });

  it("detaching the last skill leaves an empty list, not a broken line", () => {
    const one = persona.replace("mcpServers: [bittensor, fez-wallet]", "mcpServers: [solo]");
    expect(detachSkill(one, "solo")!).toContain("mcpServers: []");
  });

  it("detaching something not declared changes nothing", () => {
    expect(detachSkill(persona, "github")).toBeUndefined();
  });

  it("a persona with no mcpServers line gains one on attach", () => {
    const bare = `---\nharness: pi\ndescription: hi\n---\nYou are bare.\n`;
    const out = attachSkill(bare, "wallet", "npm:@fezchat/wallet")!;
    expect(out).toContain("mcpServers: [wallet=npm:@fezchat/wallet]");
    expect(out).toContain("harness: pi");
    expect(out).toContain("You are bare.");
  });

  it("a file with no frontmatter is refused rather than mangled", () => {
    expect(attachSkill("just a prompt, no frontmatter\n", "wallet")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --prefix packages/fez-evals -- skill-attach.test.ts
```
Expected: FAIL — cannot find module `skill-attach.js`.

- [ ] **Step 3: Implement `packages/fez-desktop/src/skill-attach.ts`**

```ts
import { parseSkillEntries, formatSkillEntries } from "@fezchat/client";

/**
 * Editing the one frontmatter line that binds an agent to its skills.
 *
 * Pure and React-free so it can be tested directly (same arrangement as
 * onboarding-steps.ts). Every function returns `undefined` for "no
 * change needed, or this file isn't safe to edit" — callers skip the
 * write rather than round-tripping a file they'd only rewrite
 * identically, which is how unknown frontmatter keys and hand-written
 * formatting survive.
 */

const LINE = /^mcpServers:\s*\[([^\]]*)\]/m;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseLine(content: string): { names: string[]; sources: Record<string, string> } {
  const line = LINE.exec(content);
  if (!line) return { names: [], sources: {} };
  return parseSkillEntries(line[1].split(",").map((s) => s.trim()).filter(Boolean));
}

/** What this persona declares, in order, with any recorded source. */
export function declaredSkills(content: string): { name: string; source?: string }[] {
  const { names, sources } = parseLine(content);
  return names.map((name) => ({ name, source: sources[name] }));
}

function writeLine(content: string, names: string[], sources: Record<string, string>): string | undefined {
  const rendered = `mcpServers: [${formatSkillEntries(names, sources)}]`;
  const line = LINE.exec(content);
  if (line) return content.replace(line[0], rendered);
  // No line yet — insert it as the last frontmatter key, so the block
  // stays a block and the body is never touched.
  const fm = FRONTMATTER.exec(content);
  if (!fm) return undefined;
  return content.replace(fm[0], `---\n${fm[1]}\n${rendered}\n---`);
}

/** Add a skill. `source` makes the persona portable; omit it for hand-rolled skills. */
export function attachSkill(content: string, skill: string, source?: string): string | undefined {
  if (!FRONTMATTER.test(content)) return undefined;
  const { names, sources } = parseLine(content);
  if (names.includes(skill)) return undefined;
  const next = [...names, skill];
  return writeLine(content, next, source ? { ...sources, [skill]: source } : sources);
}

/** Remove a skill, preserving every survivor's recorded source. */
export function detachSkill(content: string, skill: string): string | undefined {
  const { names, sources } = parseLine(content);
  if (!names.includes(skill)) return undefined;
  return writeLine(content, names.filter((n) => n !== skill), sources);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build --prefix packages/fez-client
npm test --prefix packages/fez-evals -- skill-attach.test.ts
```
Expected: PASS.

- [ ] **Step 5: Widen the config-store skill type**

In `packages/fez-desktop/src/config-store.ts`, replace the `skills` field of `AppConfig` (line 18-19):

```ts
  /** settings.json mcpServers — installed skills, their env, and install provenance. */
  skills: Record<
    string,
    {
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      package?: string;
      source?: string;
      description?: string;
    }
  >;
```

No other change: `read_skills` already returns the raw JSON, so the new fields arrive with no Rust or command work.

- [ ] **Step 6: Typecheck the desktop**

```bash
npx tsc --noEmit -p packages/fez-desktop
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-desktop/src/skill-attach.ts packages/fez-desktop/src/config-store.ts packages/fez-evals/tests/skill-attach.test.ts
git commit -m "desktop: one pure module for attaching a skill to an agent

Three surfaces are about to want the same write. attachSkill/detachSkill
edit only the mcpServers line, always through formatSkillEntries so the
portable name=source form is preserved, and return undefined when
nothing needs writing — which is how unknown frontmatter keys and
hand-written formatting survive a round trip."
```

---

### Task 5: The agent editor picker

**Files:**
- Modify: `packages/fez-desktop/src/PersonaEditor.tsx:192-200` (replace the free-text input)
- Create: `packages/fez-desktop/src/SkillPicker.tsx`
- Test: manual (React; the logic it uses is covered by Task 4)

**Interfaces:**
- Consumes: `useConfig()` (widened in Task 4), `machineLocalPath` from `@fezchat/client`
- Produces: `<SkillPicker value={string[]} sources={Record<string,string>} onChange={(names, sources) => void} />` — a standalone component, deliberately independent of `PersonaEditor` so a future agent-creation flow can reuse it unchanged (spec: "Deferred").

- [ ] **Step 1: Create the picker component**

Create `packages/fez-desktop/src/SkillPicker.tsx`:

```tsx
import { useMemo } from "react";
import { machineLocalPath } from "@fezchat/client";
import { useConfig } from "./config-store";

/**
 * Pick an agent's skills from what this machine actually has.
 *
 * Replaces a free-text box that required typing a settings.json key from
 * memory — the reason @deployer asks for a "docker" nobody installed.
 * Standalone by design: an agent-creation flow should be able to drop
 * this in unchanged.
 */
export default function SkillPicker({
  value,
  sources,
  onChange,
}: {
  value: string[];
  sources: Record<string, string>;
  onChange: (names: string[], sources: Record<string, string>) => void;
}) {
  const { skills } = useConfig();

  // Installed skills, plus anything the persona names that isn't
  // installed — a dead reference must stay VISIBLE and removable, not
  // silently vanish from the list that is supposed to explain the agent.
  const rows = useMemo(() => {
    const installed = Object.entries(skills).map(([name, config]) => ({
      name,
      description: config.description,
      source: config.source,
      local: !!machineLocalPath(config),
      missing: false,
    }));
    const known = new Set(installed.map((r) => r.name));
    const dangling = value
      .filter((name) => !known.has(name))
      .map((name) => ({ name, description: undefined, source: sources[name], local: false, missing: true }));
    return [...installed, ...dangling].sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, value, sources]);

  const toggle = (name: string, source: string | undefined, on: boolean) => {
    if (on) {
      onChange([...value, name], source ? { ...sources, [name]: source } : sources);
    } else {
      const { [name]: _dropped, ...rest } = sources;
      onChange(value.filter((n) => n !== name), rest);
    }
  };

  if (rows.length === 0) {
    return <div className="settings-hint">No skills installed yet — find some in the Skills tab.</div>;
  }

  return (
    <div className="skill-picker">
      {rows.map((row) => {
        const checked = value.includes(row.name);
        return (
          <label key={row.name} className={row.missing ? "skill-pick missing" : "skill-pick"}>
            <input type="checkbox" checked={checked} onChange={(e) => toggle(row.name, row.source, e.target.checked)} />
            <span className="skill-pick-name">{row.name}</span>
            {row.description && <span className="skill-pick-desc">{row.description}</span>}
            {row.missing && <span className="role-tag missing-tag">not installed</span>}
            {row.local && <span className="role-tag" title="points into a local directory — won't work on another machine">local</span>}
          </label>
        );
      })}
      <div className="settings-hint">Applies on next spawn — a running agent keeps the skills it started with.</div>
    </div>
  );
}
```

- [ ] **Step 2: Use it in `PersonaEditor.tsx`**

Add the import at the top:

```tsx
import SkillPicker from "./SkillPicker";
import { parseSkillEntries, formatSkillEntries } from "@fezchat/client";
```

Replace the skills field block (lines 192-200) with:

```tsx
      <div className="settings-field">
        <label>skills</label>
        <SkillPicker
          value={parseSkillEntries(splitList(field("mcpServers"))).names}
          sources={parseSkillEntries(splitList(field("mcpServers"))).sources}
          onChange={(names, sources) =>
            update("mcpServers", names.length ? `[${formatSkillEntries(names, sources)}]` : "")
          }
        />
      </div>
```

Add the helper next to `listToText`/`textToList` (line 38):

```tsx
const splitList = (raw: string) =>
  raw.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
```

The pre-bracketed string is correct and matches the existing contract exactly — `textToList` (line 38-41) returns `` `[${items.join(", ")}]` `` for a non-empty list and `""` for an empty one, and `setField` drops the line entirely when handed `""`. So an agent whose last skill is unchecked loses its `mcpServers:` line rather than keeping an empty one, which is the existing behaviour.

- [ ] **Step 3: Add the styles**

In the desktop stylesheet (find it with `grep -rn "skill-row" packages/fez-desktop/src/*.css`), add:

```css
.skill-picker { display: flex; flex-direction: column; gap: 2px; }
.skill-pick { display: flex; align-items: baseline; gap: 8px; padding: 4px 2px; cursor: pointer; }
.skill-pick-name { font-weight: 500; }
.skill-pick-desc { opacity: 0.7; font-size: 0.9em; }
.skill-pick.missing .skill-pick-name { text-decoration: line-through; opacity: 0.6; }
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p packages/fez-desktop
```
Expected: no errors.

- [ ] **Step 5: Verify the round-trip by hand**

Open `~/.fez/personas/scout.md`, note its exact contents. In the app (after a Tauri rebuild — see Task 9's manual pass), toggle a skill off and on, save, and diff the file: only the `mcpServers:` line may differ.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-desktop/src/SkillPicker.tsx packages/fez-desktop/src/PersonaEditor.tsx packages/fez-desktop/src/*.css
git commit -m "desktop: pick an agent's skills instead of typing them

The editor's skills field was a plain text input with no dropdown, no
validation and no list of what's installed — you typed a settings.json
key from memory. It is now a checklist of what this machine has, with
descriptions, and a skill the persona names but hasn't got stays visible
and removable rather than silently vanishing from the list that is
supposed to explain the agent."
```

---

### Task 6: "Give to" on the skill row

**Files:**
- Modify: `packages/fez-desktop/src/SkillsView.tsx` — the installed-row actions block (around line 500-520)
- Test: manual (uses Task 4's tested logic)

**Interfaces:**
- Consumes: `attachSkill`, `detachSkill` (Task 4); `invoke("read_persona")`, `invoke("update_persona")`; the existing `wanted` array (already computed at `SkillsView.tsx:160`, listing which agents declare this skill)

- [ ] **Step 1: Add the write helper**

In `SkillsView.tsx`, next to `rememberSource` (line 715), add:

```tsx
/**
 * Give a skill to an agent, or take it back. The write is the same one
 * the persona editor performs — one line, everything else verbatim.
 */
async function setSkillOnAgent(agent: string, skill: string, source: string | undefined, on: boolean): Promise<boolean> {
  try {
    const content = await invoke<string>("read_persona", { name: agent });
    const next = on ? attachSkill(content, skill, source) : detachSkill(content, skill);
    if (!next) return false; // already in the desired state
    await invoke("update_persona", { name: agent, content: next });
    return true;
  } catch {
    return false;
  }
}
```

Add to the imports at the top of the file:

```tsx
import { attachSkill, detachSkill } from "./skill-attach";
```

- [ ] **Step 2: Render the control**

The row already computes `wanted` (the agents declaring this skill). Add local state near the other `useState` calls:

```tsx
const [givingTo, setGivingTo] = useState<string>();
const [allAgents, setAllAgents] = useState<string[]>([]);
```

Populate `allAgents` inside the existing `useEffect` that already calls `list_personas` (line 212) — it fetches the names anyway:

```tsx
        setAllAgents(names);
```

In the installed-row actions block (beside the existing `↗ list on relay` and `✕` buttons), add:

```tsx
<button className="mini" onClick={() => setGivingTo(givingTo === name ? undefined : name)}>
  give to…
</button>
```

And below the row's main content, when `givingTo === name`:

```tsx
{givingTo === name && (
  <div className="skill-give">
    {allAgents.map((agent) => {
      const has = row.wanted.includes(agent);
      return (
        <button
          key={agent}
          className={has ? "ext-filter active" : "ext-filter"}
          onClick={() =>
            void setSkillOnAgent(agent, name, row.config?.source, !has).then((ok) => {
              if (ok) {
                flash(
                  has
                    ? `@${agent} no longer has "${name}" — takes effect on next spawn`
                    : `@${agent} gets "${name}" on next spawn`
                );
                reload();
              }
            })
          }
        >
          @{agent} {has ? "✓" : ""}
        </button>
      );
    })}
  </div>
)}
```

Note: `reload()` bumps the config store, but `wanted` derives from `agentDeps`, which is loaded by the persona `useEffect`. Add a nonce so that effect re-runs after a write — declare `const [agentNonce, setAgentNonce] = useState(0);`, add `agentNonce` to that effect's dependency array, and call `setAgentNonce((n) => n + 1)` alongside `reload()` above.

- [ ] **Step 3: Add the style**

```css
.skill-give { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 0 2px; }
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p packages/fez-desktop
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/SkillsView.tsx packages/fez-desktop/src/*.css
git commit -m "desktop: give a skill to an agent from the skill's own row

The reverse of the picker, and the view that matters for a sensitive
skill: one screen now answers 'who can spend money'. Same one-line write
as the editor."
```

---

### Task 7: The install dialog offers to attach

**Files:**
- Modify: `packages/fez-desktop/src/SkillsView.tsx` — the `InstallDialog` `onDone` handler (lines 645-670)
- Test: manual

**Interfaces:**
- Consumes: `setSkillOnAgent` (Task 6), `allAgents` (Task 6)

- [ ] **Step 1: Replace the terminal toast with an offer**

The current `onDone` flashes `✓ "${done.name}" installed — declare it in a persona (mcpServers) and it loads on next spawn` — an instruction to go do the work elsewhere. Replace the `else` branch (line 668) with state that renders the offer:

Add near the other `useState` calls:

```tsx
const [justInstalled, setJustInstalled] = useState<{ name: string; source?: string }>();
```

In `onDone`, replace the `else` branch:

```tsx
              } else {
                setJustInstalled({ name: done.name, source: done.source });
              }
```

Render it above the installed list:

```tsx
{justInstalled && (
  <div className="manage-notice">
    ✓ installed {justInstalled.name} — give it to?
    <div className="skill-give">
      {allAgents.map((agent) => (
        <button
          key={agent}
          className="ext-filter"
          onClick={() =>
            void setSkillOnAgent(agent, justInstalled.name, justInstalled.source, true).then((ok) => {
              if (ok) {
                flash(`@${agent} gets "${justInstalled.name}" on next spawn`);
                setAgentNonce((n) => n + 1);
              }
            })
          }
        >
          @{agent}
        </button>
      ))}
      <button className="ext-filter" onClick={() => setJustInstalled(undefined)}>not now</button>
    </div>
  </div>
)}
```

- [ ] **Step 2: Carry the description through the install**

`InstallTarget` (line ~78) should carry the listing's `description` so the entry written to settings has one — the picker in Task 5 renders it. Add `description?: string` to the interface, set it in `fromListing` (which already has `listing.description` in hand and currently discards it), and pass it through to whatever writes the skill (`invoke("write_skill", …)`) so the stored JSON includes it.

Verify the shape `write_skill` accepts by reading `packages/fez-desktop/src-tauri/src/lib.rs:1565` — it takes `config_json` verbatim, so adding a key needs no Rust change.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit -p packages/fez-desktop
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-desktop/src/SkillsView.tsx
git commit -m "desktop: installing a skill offers to give it to an agent

The install toast used to end by telling you to go declare it in a
persona yourself — the exact step that required typing a name from
memory. It now closes the loop, and records the listing's description so
the picker has something to show."
```

---

### Task 8: Dead references and dev-tree skills are visible

**Files:**
- Create: `packages/fez-desktop/src/agent-skill-health.ts`
- Modify: `packages/fez-desktop/src/AgentsPane.tsx` (the agent/persona rows, around lines 350-380)
- Test: `packages/fez-evals/tests/agent-skill-health.test.ts` (create)

**Interfaces:**
- Consumes: `resolveInstalledSkill`, `machineLocalPath` from `@fezchat/client`; `declaredSkills` (Task 4)
- Produces: `agentSkillHealth(personaContent: string, catalog: Record<string, SkillEntry>): { missing: string[]; local: string[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-evals/tests/agent-skill-health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { agentSkillHealth } from "../../fez-desktop/src/agent-skill-health.js";

/**
 * The two ways an agent is quietly broken, both live on the author's
 * machine: @researcher declares a github nobody installed, and @scout's
 * two skills point into a working tree that exists on one computer.
 */
describe("agent skill health", () => {
  const catalog = {
    bittensor: { command: "node", args: ["/Users/ken/Projects/fez/packages/fez-bittensor/dist/mcp.js"], package: "@fezchat/bittensor" },
    "web-search": { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], package: "@brave/brave-search-mcp-server" },
  };
  const persona = (skills: string) => `---\nharness: claude-code\nmcpServers: [${skills}]\n---\nbody\n`;

  it("names skills that resolve to nothing", () => {
    expect(agentSkillHealth(persona("web-search, github"), catalog).missing).toEqual(["github"]);
  });

  it("names skills whose command points into a local directory", () => {
    expect(agentSkillHealth(persona("bittensor"), catalog).local).toEqual(["bittensor"]);
  });

  it("a published skill run through npx is not local", () => {
    expect(agentSkillHealth(persona("web-search"), catalog).local).toEqual([]);
  });

  it("a healthy agent reports nothing", () => {
    expect(agentSkillHealth(persona("web-search"), catalog)).toEqual({ missing: [], local: [] });
  });

  it("an agent declaring no skills reports nothing", () => {
    expect(agentSkillHealth(`---\nharness: pi\n---\nbody\n`, catalog)).toEqual({ missing: [], local: [] });
  });

  it("a missing skill is not also reported as local", () => {
    const out = agentSkillHealth(persona("github"), catalog);
    expect(out).toEqual({ missing: ["github"], local: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --prefix packages/fez-evals -- agent-skill-health.test.ts
```
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `packages/fez-desktop/src/agent-skill-health.ts`**

```ts
import { machineLocalPath, resolveInstalledSkill, type SkillEntry } from "@fezchat/client";
import { declaredSkills } from "./skill-attach";

/**
 * The two ways an agent is quietly broken.
 *
 * `missing` — declares a skill that resolves to nothing here. It spawns
 * anyway and is told to disclose the gap, which no one sees until the
 * agent gives a worse answer than it should have.
 *
 * `local` — resolves to a command inside a working directory, so the
 * agent runs on exactly this computer. Hand that persona to anyone and
 * it arrives with dead references.
 */
export function agentSkillHealth(
  personaContent: string,
  catalog: Record<string, SkillEntry>
): { missing: string[]; local: string[] } {
  const missing: string[] = [];
  const local: string[] = [];
  for (const declared of declaredSkills(personaContent)) {
    const hit = resolveInstalledSkill(catalog, declared);
    if (!hit) {
      missing.push(declared.name);
      continue;
    }
    if (machineLocalPath(hit.entry)) local.push(declared.name);
  }
  return { missing, local };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build --prefix packages/fez-client
npm test --prefix packages/fez-evals -- agent-skill-health.test.ts
```
Expected: PASS.

- [ ] **Step 5: Surface it in `AgentsPane.tsx`**

`AgentsPane.tsx:286` currently fetches only the persona *names* (`list_personas`) and does not read their contents in that effect. Add the reads. Alongside the existing state, add:

```tsx
const [health, setHealth] = useState<Record<string, { missing: string[]; local: string[] }>>({});
```

and replace line 286 with an effect that reads each file:

```tsx
  const { skills } = useConfig();
  useEffect(() => {
    void (async () => {
      const names = await invoke<string[]>("list_personas").catch(() => [] as string[]);
      setLocalPersonas(names);
      const next: Record<string, { missing: string[]; local: string[] }> = {};
      for (const agent of names) {
        const content = await invoke<string>("read_persona", { name: agent }).catch(() => "");
        if (content) next[agent] = agentSkillHealth(content, skills);
      }
      setHealth(next);
    })();
  }, [skills, personaNonce]);
```

`personaNonce` already exists in this component (it is bumped after persona edits), so health recomputes after a save. Add the import:

```tsx
import { useConfig } from "./config-store";
import { agentSkillHealth } from "./agent-skill-health";
``` Render a badge in the agent row:

```tsx
{health[name]?.missing.length ? (
  <span className="agent-warn" title="declared but not installed here">
    ⚠ missing: {health[name].missing.join(", ")}
  </span>
) : health[name]?.local.length ? (
  <span className="agent-warn" title="these skills point into a local directory">
    ⚠ {health[name].local.length} skill{health[name].local.length > 1 ? "s" : ""} won't work on another machine
  </span>
) : null}
```

- [ ] **Step 6: Add the style**

```css
.agent-warn { font-size: 0.85em; opacity: 0.8; }
```

- [ ] **Step 7: Typecheck and run the full suite**

```bash
npx tsc --noEmit -p packages/fez-desktop
npm test --prefix packages/fez-evals
```
Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/fez-desktop/src/agent-skill-health.ts packages/fez-desktop/src/AgentsPane.tsx packages/fez-desktop/src/*.css packages/fez-evals/tests/agent-skill-health.test.ts
git commit -m "desktop: an agent says when its skills aren't there

A dead reference printed a console warning nobody reads and the agent
spawned regardless. Both failure shapes now show next to the agent: a
skill that resolves to nothing, and a skill whose command points into a
working tree so the persona only works on this computer."
```

---

### Task 9: Near-miss frontmatter keys, and surfacing validation in the GUI

**Files:**
- Modify: `src/identity/personas.ts:243-245` (the unknown-key warning)
- Modify: `packages/fez-desktop/src/PersonaEditor.tsx` (show warnings on save)
- Test: `packages/fez-evals/tests/persona-typo.test.ts` (create)

**Interfaces:**
- Consumes: `KNOWN_EXTRA_KEYS` (already exported, `personas.ts:172`), `validatePersonaFile` (already exported)
- Produces: `nearestKnownKey(key: string): string | undefined` exported from `src/identity/personas.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-evals/tests/persona-typo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validatePersonaFile, nearestKnownKey } from "@fezchat/protocol";

/**
 * parseFrontmatter sweeps unknown keys into `extra`, so `mcpServer:`
 * (missing the s) yields an agent with no skills and no complaint. fez
 * can't reject unknown keys — extensions legitimately add them — so a
 * near-miss is called out by name while a genuine extension key is left
 * alone.
 */
describe("near-miss frontmatter keys", () => {
  it("finds the key a typo was reaching for", () => {
    expect(nearestKnownKey("mcpServer")).toBe("mcpServers");
    expect(nearestKnownKey("harnes")).toBe("harness");
    expect(nearestKnownKey("descriptin")).toBe("description");
  });

  it("leaves an unknown extension key alone when it resembles nothing", () => {
    expect(nearestKnownKey("someExtensionKey")).toBeUndefined();
    expect(nearestKnownKey("kanbanColumn")).toBeUndefined();
  });

  it("a key that IS known returns nothing — exact match is not a near miss", () => {
    // shareLevel is in KNOWN_EXTRA_KEYS. The editor calls this for every
    // key it sees, including the valid ones, so exact matches must be silent.
    expect(nearestKnownKey("shareLevel")).toBeUndefined();
    expect(nearestKnownKey("mcpServers")).toBeUndefined();
  });

  it("does not match something merely short", () => {
    // Two edits from nothing meaningful — must not claim a match.
    expect(nearestKnownKey("x")).toBeUndefined();
  });

  it("the warning names the intended key", () => {
    const raw = `---\nharness: pi\nmcpServer: [wallet]\n---\nbody\n`;
    const { warnings } = validatePersonaFile(raw, "bot");
    expect(warnings.some((w) => w.includes("mcpServer") && w.includes('did you mean "mcpServers"'))).toBe(true);
  });

  it("an unrecognized key still warns, just without a suggestion", () => {
    const raw = `---\nharness: pi\ntotallyCustom: 1\n---\nbody\n`;
    const { warnings } = validatePersonaFile(raw, "bot");
    expect(warnings.some((w) => w.includes("totallyCustom"))).toBe(true);
    expect(warnings.some((w) => w.includes("did you mean"))).toBe(false);
  });

  it("a near-miss is a warning, never an error — the key is still kept", () => {
    const raw = `---\nharness: pi\nmcpServer: [wallet]\n---\nbody\n`;
    expect(validatePersonaFile(raw, "bot").errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --prefix packages/fez-evals -- persona-typo.test.ts
```
Expected: FAIL — `nearestKnownKey is not a function`.

- [ ] **Step 3: Implement in `src/identity/personas.ts`**

Add above `validatePersonaFile`:

```ts
/** The frontmatter keys the parser reads directly, plus every extra key a fez consumer knows. */
const ALL_KNOWN_KEYS = ["harness", "aliases", "mcpServers", "description", ...KNOWN_EXTRA_KEYS];

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

/**
 * The known key an unknown one was probably reaching for, or undefined.
 *
 * Distance 2 catches the realistic typo (`mcpServer` → `mcpServers` is
 * 1) without claiming a match for a short custom key that happens to sit
 * near a known one — hence the length floor. Advisory only: the key is
 * still kept in `extra`, because extensions own keys fez has never heard
 * of and a rejection would break them.
 */
export function nearestKnownKey(key: string): string | undefined {
  if (key.length < 4) return undefined;
  let best: { key: string; distance: number } | undefined;
  for (const known of ALL_KNOWN_KEYS) {
    if (known === key) return undefined;
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { key: known, distance };
  }
  return best?.key;
}
```

Replace the unknown-key warning (lines 243-245):

```ts
    if (!KNOWN_EXTRA_KEYS.has(key)) {
      const near = nearestKnownKey(key);
      warnings.push(
        near
          ? `unknown frontmatter key "${key}" — did you mean "${near}"? As written, nothing reads it.`
          : `unknown frontmatter key "${key}" — no fez consumer reads it (typo? extensions that own it can ignore this)`
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --prefix packages/fez-evals -- persona-typo.test.ts
```
Expected: PASS.

- [ ] **Step 5: Mirror only the key check into the browser**

`validatePersonaFile` is Node-only and is **not** exported from `@fezchat/client` (verified). Mirroring the whole validator would drag in `parseFrontmatter`, the size limits, and `parseSkillSource` — too much for the one thing the editor needs. Mirror only the key check.

Create `packages/fez-client/src/persona-keys.ts`:

```ts
/**
 * Frontmatter key names — the browser-safe mirror.
 *
 * The canonical list is KNOWN_EXTRA_KEYS in src/identity/personas.ts
 * (Node-only: it lives beside the persona loader). The editor needs the
 * same answer to "is this key a typo?" and cannot import Node, so the
 * list and the matcher are duplicated here and persona-typo.test.ts runs
 * BOTH over one table — a key added to one and not the other is a red
 * test, not an editor that disagrees with the CLI.
 *
 * Only the key check is mirrored. Size limits, harness checks and source
 * validation stay CLI-side; they are not what the editor needs to say.
 */
export const ALL_KNOWN_KEYS = [
  // parsed directly by parseFrontmatter
  "harness", "aliases", "mcpServers", "description",
  // KNOWN_EXTRA_KEYS, mirrored from src/identity/personas.ts:172
  "workdir", "repo", "branch", "scope",
  "provider", "model", "effort", "packages",
  "routable", "idleExit", "idleTimeoutS", "turnTimeoutS",
  "url", "channels", "owner", "respondTo",
  "maxReplyChars", "shareLevel", "approvalQuorum",
];

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

/** The known key an unknown one was probably reaching for, or undefined. */
export function nearestKnownKey(key: string): string | undefined {
  if (key.length < 4) return undefined;
  let best: { key: string; distance: number } | undefined;
  for (const known of ALL_KNOWN_KEYS) {
    if (known === key) return undefined;
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { key: known, distance };
  }
  return best?.key;
}
```

Add `export * from "./persona-keys.js";` to `packages/fez-client/src/index.ts`.

Extend `persona-typo.test.ts` with the parity block (this is what keeps the two lists honest):

```ts
import * as mirror from "../../fez-client/dist/index.js";

describe("the browser mirror agrees with the CLI", () => {
  for (const key of ["mcpServer", "harnes", "descriptin", "shareLevel", "someExtensionKey", "x", "mcpServers"]) {
    it(`agrees on "${key}"`, () => {
      expect(mirror.nearestKnownKey(key)).toBe(nearestKnownKey(key));
    });
  }
});
```

- [ ] **Step 6: Show the warnings in the editor**

`PersonaEditor` already parses frontmatter into a `front: string[]` array (`parsePersona`, line 16), so it needs no new parser. In the component, derive warnings from the keys it already has:

```tsx
import { nearestKnownKey } from "@fezchat/client";

const keyWarnings = useMemo(
  () =>
    front
      .map((line) => /^([\w-]+):/.exec(line)?.[1])
      .filter((k): k is string => !!k)
      .map((k) => ({ key: k, near: nearestKnownKey(k) }))
      .filter((w) => w.near),
  [front]
);
```

Render above the save button:

```tsx
{keyWarnings.length > 0 && (
  <div className="settings-hint">
    {keyWarnings.map((w) => (
      <div key={w.key}>⚠ "{w.key}" — did you mean "{w.near}"? As written, nothing reads it.</div>
    ))}
  </div>
)}
```

Warnings never block the save — advisory, matching the CLI.

- [ ] **Step 7: Full suite plus typecheck**

```bash
npm run build --prefix packages/fez-client
npm test --prefix packages/fez-evals
npx tsc --noEmit -p packages/fez-desktop
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/identity/personas.ts packages/fez-client/src/persona-keys.ts packages/fez-client/src/index.ts packages/fez-desktop/src/PersonaEditor.tsx packages/fez-evals/tests/persona-typo.test.ts
git commit -m "personas: a typo'd frontmatter key says what you meant

parseFrontmatter sweeps unknown keys into extra, so 'mcpServer:' yields
an agent with no skills and no complaint. A key within two edits of a
known one now names the key it was reaching for. Still a warning, never
an error — extensions own keys fez has never heard of. And the GUI
finally shows these warnings at all: validatePersonaFile had exactly one
caller, the CLI."
```

---

### Task 10: Manual verification pass

The spec's whole claim is about what a GUI-only user can do, so the last gate is the app itself.

**Files:** none (verification only)

- [ ] **Step 1: Build and install the desktop app**

```bash
npm run build --prefix packages/fez-client
npm run build
cd packages/fez-desktop && npm run tauri build
```

Swap the built app into `/Applications` (per the project's usual rebuild step; `cargo` must be on PATH).

- [ ] **Step 2: Verify the three surfaces**

- Agent editor: open @scout → skills is a checklist showing `bittensor` and `fez-wallet` with descriptions and a `local` tag on both.
- Skill row: Skills → installed → `fez-wallet` shows `used by @scout` and a working `give to…`.
- Install dialog: install any skill from the browse tab → the offer appears with agent buttons.

- [ ] **Step 3: Verify the failure surfaces**

- @researcher shows `⚠ missing: github`.
- @scout shows the dev-tree warning.
- Save a persona with `mcpServer:` typed by hand → the editor shows `did you mean "mcpServers"?`.

- [ ] **Step 4: Verify the round-trip did no damage**

```bash
git -C ~/.fez diff 2>/dev/null || diff <(cat ~/.fez/personas/scout.md) /tmp/scout-before.md
```

Copy `~/.fez/personas/scout.md` to `/tmp/scout-before.md` before step 2. After toggling a skill off and on again, only the `mcpServers:` line may differ, and it must be byte-identical if you ended where you started.

- [ ] **Step 5: Run the e2e gate**

```bash
npm run test:e2e --prefix packages/fez-desktop
```
Expected: PASS. Per project practice, a desktop release requires the cold-start e2e to pass on the mini — this plan does not ship a release, but the suite must not regress.

- [ ] **Step 6: Commit any fixes found**

If the manual pass turns up defects, fix them with a test first where the logic is testable, and commit each fix separately.

---

## Notes for the implementer

**What this plan does not do**, deliberately, all recorded in the spec's "Deferred" section: no agent-creation wizard, no `SKILL.md` instruction tier, no agent-facing discovery of unattached skills, and no auto-install from a persona file (that last one is a settled *no* — `agent.ts:196` explains why, and it must stay true).

**Two departures from the spec**, both found while planning against the code:

1. **No stored `local` field.** `machineLocalPath` already derives it and the GUI already calls it. Storing it would be a second source of truth that can go stale.
2. **No new Tauri command.** The spec's "supporting seam" is unnecessary: `read_skills` already returns raw settings JSON, so the new fields arrive for free.

**The migration story is "none".** Step 1 of the resolver is the existing behaviour, so every persona on disk keeps working unchanged. Provenance is additive and appears as things are installed or updated. Nothing rewrites a persona without the user clicking something.
