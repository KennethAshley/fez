# Skills Standard (SKILL.md tier + tools rename) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fez adopts the ecosystem's vocabulary — skill = SKILL.md instruction pack attachable to agents (progressive disclosure via `fez_load_skill`), tool = MCP server — and the install-from-chat converter lands ponytail-class repos as attachable skills.

**Architecture:** A skill ships inside a package (`fez.skills: {dir}` manifest key, files materialized under `~/.fez/packages/<pkg>/`), attaches via a new `skills:` persona frontmatter key (same alias=source grammar as `mcpServers:`, which is untouched), and reaches agents as name+description in the spawn prompt plus a `fez_load_skill` fez-mcp tool that returns the body on demand (attached set handed over via `FEZ_AGENT_SKILLS` env). User-facing strings flip: MCP "skills" → "tools", loom's "tools" → "artifacts"; wire constants keep their names.

**Tech Stack:** TypeScript (core, fez-acp, fez-mcp, fez-desktop React), Rust (src-tauri package_install), vitest (root runner), cargo test.

**Spec:** `docs/superpowers/specs/2026-08-30-skills-standard-design.md`

**Branch note:** work continues on `install-from-chat` in the worktree `.claude/worktrees/install-from-chat` — the converter retarget (Task 8) needs both this tier and the acquisition rail already on that branch. One branch, one merge.

## Global Constraints

- Vocabulary: *tool* = MCP server; *skill* = SKILL.md pack. Every user-facing label/toast/help string flips. NOT renamed: wire kinds (`KIND_SKILL_LISTING` 40200, 40201, existing `artifact:` values), Rust command names (`read_skills`, `write_skill`, …), CSS class names (`.skill-row` etc.), `fez.parts.skill` manifest key, TS identifiers where rename is pure churn.
- `mcpServers:` frontmatter is untouched. New sibling key `skills: [name, alias=source]`, same first-`=` split grammar; a source names a package, never a command or path.
- Skill files live only inside `~/.fez/packages/<pkg>/` — never the legacy `~/.fez/skills/`, no flat symlinks.
- Progressive disclosure only: prompt carries name + description, never a body; bodies arrive solely via `fez_load_skill`, which accepts only names in the attached set.
- Skill file frontmatter: `description` required (files without it are skipped with a warning line at install), `name` defaults to the file stem.
- Loom's sidebar item and view labels: "tools" → "artifacts".
- Commit messages plain, no co-author or session trailers.
- Test env: run vitest from the worktree root (`npx vitest --run <paths>`); fez-evals bootstrap/cold-start suites fail there for missing dist builds (known env noise — leave them); playwright e2e files under fez-desktop/tests/e2e are known collection noise. cargo tests run in `packages/fez-desktop/src-tauri`.

---

### Task 1: Persona frontmatter — the `skills:` key

**Files:**
- Modify: `src/identity/personas.ts` (parseFrontmatter ~108-131, Persona interface ~44-68, serializePersona ~144-158, ALL_KNOWN_KEYS ~218)
- Test: `packages/fez-evals/tests/persona-skills-key.test.ts`

**Interfaces:**
- Consumes: existing `parseSkillEntries(entries) -> {names, sources}` (personas.ts:93) — reuse verbatim for the new key.
- Produces (Tasks 3, 5 rely on these): `Persona` gains `skills: string[]` and `skillSources: Record<string, string>`; `parsePersona`/`parseFrontmatter` fill them from a `skills:` frontmatter line; `serializePersona(harness, aliases, mcpServers, systemPrompt, skills?: string[])` emits a `skills: [a, b=src]` line when non-empty; `"skills"` joins the known-keys set and `ALL_KNOWN_KEYS`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parsePersona, serializePersona } from "../../../src/identity/personas";

describe("skills: frontmatter key", () => {
  it("parses names and sources with the mcpServers grammar", () => {
    const p = parsePersona("x", "---\nharness: pi\nskills: [ponytail, review=npm:@fezchat/ponytail]\nmcpServers: [wallet]\n---\nBody.");
    expect(p.skills).toEqual(["ponytail", "review"]);
    expect(p.skillSources).toEqual({ review: "npm:@fezchat/ponytail" });
    expect(p.mcpServers).toEqual(["wallet"]); // untouched
    expect(p.extra.skills).toBeUndefined();   // known key, not extra
  });
  it("defaults to empty and round-trips through serializePersona", () => {
    const p = parsePersona("x", "---\nharness: pi\n---\nBody.");
    expect(p.skills).toEqual([]);
    const out = serializePersona("pi", [], ["wallet"], "Body.", ["ponytail", "review=npm:@fezchat/ponytail"]);
    expect(out).toContain("skills: [ponytail, review=npm:@fezchat/ponytail]");
    const back = parsePersona("x", out);
    expect(back.skills).toEqual(["ponytail", "review"]);
  });
});
```

(Adjust the `parsePersona` call signature to match the file — check its export; if the entry point is a different function name, use that one, keeping the assertions.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest --run packages/fez-evals/tests/persona-skills-key.test.ts` → `p.skills` undefined.

- [ ] **Step 3: Implement** in personas.ts:
  - Persona interface: add `skills: string[];` and `skillSources: Record<string, string>;` with a doc comment mirroring mcpServers/mcpSources ("SKILL.md packs this persona attaches — see the skills-standard spec").
  - `parseFrontmatter`: add `"skills"` to the `known` set (line ~119); `const skillMds = parseSkillEntries(meta.skills ? parseList(meta.skills) : []);` and return `skills: skillMds.names, skillSources: skillMds.sources` (plus the empty-object defaults in the no-frontmatter early return at ~110).
  - `serializePersona`: add optional trailing param `skills: string[] = []`; validate entries through the same guard loop as mcpServers; emit `skills: [${skills.join(", ")}]\n` after the mcpServers line.
  - `ALL_KNOWN_KEYS`: add `"skills"`.

- [ ] **Step 4: Run** the new test + neighbors: `npx vitest --run packages/fez-evals/tests/persona-skills-key.test.ts packages/fez-evals/tests/skill-source.test.ts packages/fez-evals/tests/skill-attach.test.ts` → all PASS.

- [ ] **Step 5: Commit** — `git commit -m "personas: skills: frontmatter key, the SKILL.md attach list"`

---

### Task 2: Skill packages — `fez.skills` install part + discovery

**Files:**
- Create: `src/extensions/skills-md.ts`
- Modify: `src/extensions/package-manager.ts` (FezManifest ~43-119, installParts ~885, has-content logic), `packages/fez-desktop/src-tauri/src/package_install.rs` (`install_from_tarball`, `has_installable_content`), `packages/fez-desktop/src-tauri/src/lib.rs` (new command `list_installed_skills`, register in invoke_handler ~2318)
- Test: `packages/fez-evals/tests/skills-md.test.ts`, Rust tests in `package_install.rs`

**Interfaces:**
- Produces:
  - Manifest: `fez.skills?: { dir?: string }` (default dir `"skills"`), files `<dir>/*.md`.
  - `src/extensions/skills-md.ts`:
    ```ts
    export interface InstalledSkill { pkg: string; id: string; name: string; description: string; path: string }
    /** Walk ~/.fez/packages/*/package.json for fez.skills and read each md's frontmatter. */
    export function skillsInstalled(home?: string): InstalledSkill[]
    /** Parse a skill md: {name (default = file stem), description ("" if absent), body}. */
    export function parseSkillMd(raw: string, stem: string): { name: string; description: string; body: string }
    ```
  - Rust Tauri command: `list_installed_skills() -> Result<String, String>` — JSON `[{pkg, id, name, description}]` (no path — the webview never needs one).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing TS test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsInstalled, parseSkillMd } from "../../../src/extensions/skills-md";

describe("skillsInstalled", () => {
  it("finds fez.skills packages and reads frontmatter", () => {
    const home = mkdtempSync(join(tmpdir(), "fez-skills-"));
    const pkg = join(home, "packages", "gh-x-ponytail");
    mkdirSync(join(pkg, "skills"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "gh-x-ponytail", fez: { skills: { dir: "skills" } } }));
    writeFileSync(join(pkg, "skills", "ponytail.md"), "---\ndescription: lazy senior dev\n---\nBe lazy.");
    writeFileSync(join(pkg, "skills", "no-desc.md"), "No frontmatter.");
    const found = skillsInstalled(home);
    expect(found).toHaveLength(1); // description required; no-desc skipped
    expect(found[0]).toMatchObject({ pkg: "gh-x-ponytail", id: "ponytail", name: "ponytail", description: "lazy senior dev" });
    expect(found[0].path.endsWith("skills/ponytail.md")).toBe(true);
  });
  it("parseSkillMd defaults name to the stem", () => {
    expect(parseSkillMd("---\nname: The Pony\ndescription: d\n---\nB", "pony"))
      .toEqual({ name: "The Pony", description: "d", body: "B" });
    expect(parseSkillMd("plain", "pony").name).toBe("pony");
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `skills-md.ts`** — plain `readdirSync` walk of `<home>/packages/*/package.json`; frontmatter parsing by the same line-prefix technique `personas.ts` uses (no YAML dep); skills without `description` are skipped. Default `home` = `~/.fez` (match how package-manager.ts resolves it).

- [ ] **Step 4: TS install path** — in `package-manager.ts`: add `skills?: { dir?: string }` to `FezManifest.fez`; in `installParts`, when `manifest.fez.skills` exists, copy `<dir>/*.md` from the package source into the package dir (they ship inside the npm tarball already — materializing the dir is enough; follow how `fez.personas` files are handled but into the package dir, NOT `~/.fez/personas`); count skills toward "has installable content".

- [ ] **Step 5: Rust mirror** — `package_install.rs`: in `has_installable_content`, treat `fez.skills` as installable; in `install_from_tarball`, materialize each `<dir>/*.md` via the existing `materialize()` (path-escape gate included) and push `format!("skill {id} → packages/{base}/{dir}/{id}.md")` into `installed`. Rust test (beside the existing fixtures):

```rust
#[test]
fn a_skills_package_installs_md_into_the_package_dir() {
    // fixture tar with package.json {fez:{skills:{dir:"skills"}}} + package/skills/pony.md
    // assert install_from_tarball succeeds and packages/<base>/skills/pony.md exists,
    // and that NO ~/.fez/skills/ dir is created.
}
```

(Write the fixture with the file's existing `fixture_tar()` helpers.)

- [ ] **Step 6: `list_installed_skills` command** — in lib.rs: walk `home/packages/*/package.json`, parse `fez.skills`, read each md's `name:`/`description:` line-prefix frontmatter (skip missing description), return the JSON array; register in `invoke_handler`.

- [ ] **Step 7: Run** — `npx vitest --run packages/fez-evals/tests/skills-md.test.ts` PASS; `cargo test` in src-tauri all PASS.

- [ ] **Step 8: Commit** — `git commit -m "skill packages: fez.skills part installs md into the package dir, discovery on both sides"`

---

### Task 3: Runtime — spawn prompt section + FEZ_AGENT_SKILLS

**Files:**
- Create: `packages/fez-acp/src/skills-prompt.ts`
- Modify: `packages/fez-acp/src/agent.ts` (~206-264 resolution block, env list ~253, prompt builds ~1463 and ~1787, capability-honesty bullet ~1495)
- Test: `packages/fez-evals/tests/skills-prompt.test.ts`

**Interfaces:**
- Consumes: `skillsInstalled()` / `InstalledSkill` (Task 2), persona `skills`/`skillSources` (Task 1).
- Produces:
  ```ts
  // skills-prompt.ts
  import type { InstalledSkill } from "…/skills-md" // match agent.ts's import style for core modules
  export function resolveAttachedSkills(declared: string[], installed: InstalledSkill[]):
    { attached: InstalledSkill[]; missing: string[] }
  /** The [Skills] prompt section, or undefined when none attached. Never includes a body. */
  export function skillsPromptSection(attached: InstalledSkill[]): string | undefined
  /** JSON for FEZ_AGENT_SKILLS: {"<name>": "<abs path>"} */
  export function skillsEnvJson(attached: InstalledSkill[]): string
  ```
- Section text (exact):
  ```
  [Skills]
  You have these skills — load one with fez_load_skill when its description matches the task; follow a loaded skill until done.
  - <name>: <description>
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveAttachedSkills, skillsPromptSection, skillsEnvJson } from "../../fez-acp/src/skills-prompt";

const pony = { pkg: "p", id: "ponytail", name: "ponytail", description: "lazy senior dev", path: "/x/ponytail.md" };

describe("skills prompt", () => {
  it("resolves declared against installed, reports missing", () => {
    const r = resolveAttachedSkills(["ponytail", "ghost"], [pony]);
    expect(r.attached).toEqual([pony]);
    expect(r.missing).toEqual(["ghost"]);
  });
  it("section lists name+description, never the body; empty -> undefined", () => {
    const s = skillsPromptSection([pony])!;
    expect(s).toContain("fez_load_skill");
    expect(s).toContain("- ponytail: lazy senior dev");
    expect(skillsPromptSection([])).toBeUndefined();
  });
  it("env json maps name to path", () => {
    expect(JSON.parse(skillsEnvJson([pony]))).toEqual({ ponytail: "/x/ponytail.md" });
  });
});
```

(Match the import path style of other fez-evals tests importing from fez-acp src; if they import dist, import the src path anyway — vitest transforms TS.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** skills-prompt.ts (pure functions; resolve by `id` OR `name`, first match wins).

- [ ] **Step 4: Wire agent.ts** — after the mcpServers resolution block (~line 224): load `skillsInstalled()`, `resolveAttachedSkills(persona.skills, installed)`; append missing skill names into the existing capability-honesty mechanism (extend the `missingSkills` list with a `(skill)` marker or a parallel bullet: `your persona declares skills that are NOT installed: <names>` — mirror the existing bullet's tone at ~1495); add `{ name: "FEZ_AGENT_SKILLS", value: skillsEnvJson(attached) }` to the fez-mcp env list (~253, only when attached.length > 0); in BOTH prompt builds insert `...(skillsSection ? [skillsSection] : [])` immediately after the `memory.section` spread (~1463 channel, ~1787 DM), where `skillsSection = skillsPromptSection(attached)` computed once at spawn.

- [ ] **Step 5: Run** — the new test + `npx vitest --run packages/fez-evals/tests/skill-resolve-spawn.test.ts` (guards the untouched tools path) → PASS.

- [ ] **Step 6: Commit** — `git commit -m "acp: attached skills advertise name+description at spawn, bodies stay behind fez_load_skill"`

---

### Task 4: fez-mcp — `fez_load_skill`

**Files:**
- Create: `packages/fez-mcp/src/skills.ts`
- Modify: `packages/fez-mcp/src/server.ts` (env docs ~34-35, one `registerTool` beside the memory tools ~352)
- Test: `packages/fez-evals/tests/fez-mcp-load-skill.test.ts`

**Interfaces:**
- Consumes: `FEZ_AGENT_SKILLS` env JSON `{name: absPath}` (Task 3).
- Produces:
  ```ts
  // skills.ts — pure, testable without a server
  /** Parse FEZ_AGENT_SKILLS; bad/missing json -> {} */
  export function attachedSkills(envJson: string | undefined): Record<string, string>
  /** Body of an attached skill, or an Error naming the attached set. */
  export function loadSkillBody(name: string, attached: Record<string, string>): string
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachedSkills, loadSkillBody } from "../../fez-mcp/src/skills";

describe("fez_load_skill core", () => {
  it("returns the body for an attached name only", () => {
    const dir = mkdtempSync(join(tmpdir(), "fez-mcp-skill-"));
    const p = join(dir, "ponytail.md");
    writeFileSync(p, "---\ndescription: d\n---\nBe lazy.");
    const set = attachedSkills(JSON.stringify({ ponytail: p }));
    expect(loadSkillBody("ponytail", set)).toContain("Be lazy.");
    expect(() => loadSkillBody("evil", set)).toThrow(/ponytail/); // error names the attached set
  });
  it("tolerates absent/garbled env", () => {
    expect(attachedSkills(undefined)).toEqual({});
    expect(attachedSkills("not json")).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** skills.ts (return the file verbatim — frontmatter included is fine, it's instructions either way; refuse names not in the set: `throw new Error(\`unknown skill "\${name}" — attached: \${Object.keys(attached).join(", ") || "none"}\`)`).

- [ ] **Step 4: Register the tool** in server.ts, following the existing `registerTool` pattern exactly:

```ts
const skills = attachedSkills(process.env.FEZ_AGENT_SKILLS);
server.registerTool(
  "fez_load_skill",
  {
    description: "Load the full instructions of one of your attached skills. Call it when a skill's description matches the task; then follow the loaded skill until done.",
    inputSchema: { name: z.string().describe("an attached skill name, exactly as listed in your [Skills] section") },
  },
  async ({ name }) => {
    try { return text(loadSkillBody(name, skills)); }
    catch (e) { return text(String(e instanceof Error ? e.message : e)); }
  }
);
```

(Use the file's local `text()` helper as the other tools do.) Update the env doc comment at ~34: add `FEZ_AGENT_SKILLS (enables fez_load_skill)`.

- [ ] **Step 5: Run** the new test → PASS; `npx tsc --noEmit` for fez-mcp if the package has a check script.

- [ ] **Step 6: Commit** — `git commit -m "fez-mcp: fez_load_skill serves attached SKILL.md bodies on demand"`

---

### Task 5: Attach surfaces — picker, give-to, health

**Files:**
- Modify: `packages/fez-desktop/src/skill-attach.ts` (~101-180), `packages/fez-desktop/src/SkillPicker.tsx`, `packages/fez-desktop/src/PersonaEditor.tsx` (~248-263), `packages/fez-desktop/src/agent-skill-health.ts`
- Test: `packages/fez-desktop/tests/skill-attach-md.test.ts`

**Interfaces:**
- Consumes: `skills:` frontmatter grammar (Task 1), `list_installed_skills` Tauri command (Task 2).
- Produces: every exported fn in skill-attach.ts gains a trailing `key: "mcpServers" | "skills" = "mcpServers"` parameter — `declaredSkills(content, key?)`, `attachSkill(content, skill, source?, key?)`, `detachSkill(content, skill, key?)`, `rememberSkillSource(content, skill, source, key?)` — operating on the named frontmatter line with the same scoped-regex + `safeSkillName`/`safeSkillSource` guards. SkillPicker renders two sections: **skills** (from `invoke("list_installed_skills")`, writes the `skills:` key) above **tools** (unchanged).

- [ ] **Step 1: Write the failing test** (pure functions; jsdom not needed)

```ts
import { describe, it, expect } from "vitest";
import { attachSkill, detachSkill, declaredSkills } from "../src/skill-attach";

const persona = "---\nharness: pi\nmcpServers: [wallet]\n---\nBody.";

describe("skill-attach on the skills: key", () => {
  it("attaches into skills: without touching mcpServers:", () => {
    const out = attachSkill(persona, "ponytail", undefined, "skills")!;
    expect(out).toContain("skills: [ponytail]");
    expect(out).toContain("mcpServers: [wallet]");
    expect(declaredSkills(out, "skills").map((s) => s.name)).toEqual(["ponytail"]);
    expect(declaredSkills(out).map((s) => s.name)).toEqual(["wallet"]); // default key unchanged
  });
  it("detaches from the right key", () => {
    const out = detachSkill(attachSkill(persona, "ponytail", undefined, "skills")!, "ponytail", "skills")!;
    expect(out).not.toContain("skills: [");
    expect(out).toContain("mcpServers: [wallet]");
  });
});
```

- [ ] **Step 2: Run to verify failure** (extra-arg overloads don't exist).

- [ ] **Step 3: Implement** the key parameter in skill-attach.ts (replace the literal `mcpServers` in its frontmatter-scoped regexes with the key; default keeps every existing call site working — do not touch callers).

- [ ] **Step 4: SkillPicker + editor** — SkillPicker fetches `list_installed_skills` on mount (alongside its current data), renders a `skills` checkbox section above the current list (relabeled `tools`, see Task 6's strings — here just the structure); checking/unchecking calls the attach/detach path with `key: "skills"` through the same write flow the tools rows use (`skill-attach.ts` consumers — follow how PersonaEditor persists today). A skill row shows `name — description`.

- [ ] **Step 5: Health** — `agent-skill-health.ts`: personas declaring `skills:` names with no installed match report them the same way dangling tools are reported (extend whatever structure feeds `SkillHealthBadge`; a missing skill's hint is `install it from chat or ⊞ extensions`).

- [ ] **Step 6: Run** — new test + `npx vitest --run packages/fez-desktop/tests` (real tests green) + `npx tsc --noEmit -p packages/fez-desktop`.

- [ ] **Step 7: Commit** — `git commit -m "attach surfaces: skills join the picker, give-to, and health beside tools"`

---

### Task 6: Rename wave — desktop strings

**Files:**
- Modify: `packages/fez-desktop/src/SkillsView.tsx`, `SkillPicker.tsx`, `SkillSecrets.tsx`, `AgentCard.tsx`, `AgentProfile.tsx`, `AgentsPage.tsx`, `AgentsPane.tsx`, `HoverCard.tsx`, `FindSource.tsx`, `Onboarding.tsx`, `ManagePane.tsx`, `SettingsPane.tsx`, `App.tsx` (nav)

**Verbatim replacement guide** (user-visible strings only — identifiers, CSS classes, view-kind keys stay):
- App.tsx nav: `["⚒", "skills", …]` label → `tools`; the loom nav item currently labeled `tools` → `artifacts` (find it by the loom/generative view it opens; keep its icon).
- SkillsView title `🔧 skills` → `🔧 tools`; legend → `**Tools** are MCP servers your agents call — granted to an agent in its persona. **Skills** are instruction packs agents load — attach them in an agent's editor.`
- Every toast/banner in SkillsView/skill flows: "skill" meaning MCP → "tool" (`✓ installed {name} — give it to?` stays; `@agent gets "X" on next spawn` stays; strings containing the word skill flip).
- AgentProfile "No skills. Give it one from the Skills tab" → "No tools. Give it one from the tools tab"; AgentsPage "Give one a skill…" → "…a tool…"; AgentsPane SkillHealthBadge copy `N skills won't work…` → `N tools won't work…` (plus the new missing-skills line from Task 5 keeps the word skills).
- SettingsPane workspace section hint "services and skills" → "services and tools".
- SkillPicker section headers: `skills` (new section, Task 5) and `tools` (existing list).

- [ ] **Step 1: Apply the replacements.** Grep gate before committing:
`grep -rn "skill" packages/fez-desktop/src --include="*.tsx" | grep -iv "load_skill\|skills:\|skill pack\|instruction\|SkillPicker\|SkillsView\|SkillSecrets\|skill-attach\|skill-health\|skillEntries\|className\|import\|from \"\|//"` — review every hit: each surviving user-visible "skill" must mean a SKILL.md pack.
- [ ] **Step 2: Verify** — `npx tsc --noEmit -p packages/fez-desktop`; `npx vitest --run packages/fez-desktop/tests` (update any test asserting renamed strings).
- [ ] **Step 3: Commit** — `git commit -m "rename: tools are MCP servers, artifacts are loom's, skills is freed"`

---

### Task 7: Rename wave — CLI, core, docs

**Files:**
- Modify: `src/cli/cmd-skill.ts`, the CLI registration site that mounts it (grep `cmd-skill` in `src/cli/`), `src/cli/cmd-persona.ts`, `src/cli/cmd-extensions.ts` ("Defined skill"), `src/cli/tui.ts` (missing-skill warnings), `src/extensions/package-manager.ts` ("Defined skill" string), `packages/fez-acp/src/agent.ts` (capability bullet: `declares skills that are NOT available` → `declares tools that are NOT available`; the Task 3 skills bullet keeps "skills"), `web/content/docs/concepts/skills.mdx` → `tools.mdx` (+ meta.json), new `web/content/docs/concepts/skills.mdx` describing the SKILL.md tier (short: what a skill is, attach in editor, fez_load_skill, install from chat), `AGENTS.md`, `ONBOARDING.md`
- Test: `packages/fez-evals/tests/cli-tool-alias.test.ts`

**Interfaces:** `fez tool <add|list|remove|publish|install|market>` is the command; `fez skill` remains a hidden alias (registered, excluded from help) for one release.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// The CLI entry — match how other fez-evals CLI tests invoke it (grep for execFileSync in
// packages/fez-evals/tests/cli-*.test.ts and copy that harness exactly).
describe("fez tool", () => {
  it("tool --help exists and skill still routes as a hidden alias", () => {
    const tool = execFileSync("node", [CLI, "tool", "--help"], { encoding: "utf8" });
    expect(tool).toContain("Tools (MCP servers)");
    const skill = execFileSync("node", [CLI, "skill", "list"], { encoding: "utf8" });
    expect(skill).not.toContain("unknown command");
  });
});
```

(If no CLI-exec test harness exists in fez-evals, test the command registration function directly instead: import the register fn from cmd-skill.ts and assert the program gains both `tool` and `skill` commands — keep whichever is the established pattern.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — rename the registered command to `tool` (description `Tools (MCP servers) personas can declare — plus publishing to the marketplace`), add `skill` as a hidden alias (commander: `.alias("skill")` or a second registration with `.hidden`? — use the pattern the CLI framework in this repo supports; check how other commands register). Flip the listed output strings ("Declares tools:", "Defined tool", tui warnings). Docs: move/rewrite the mdx pair; AGENTS.md/ONBOARDING.md mentions.
- [ ] **Step 4: Run** the test + `npx vitest --run packages/fez-evals/tests/cli-relay-defaults.test.ts` (nearest CLI neighbor) → PASS.
- [ ] **Step 5: Commit** — `git commit -m "rename: fez tool CLI (skill hidden alias), docs split tools vs skills"`

---

### Task 8: Converter retarget — install-from-chat emits skill packages

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/git_install.rs` (the emission half of `convert`), `packages/fez-desktop/src/InstallOffer.tsx` (card copy), `packages/fez-desktop/tests/git-install-offer.test.tsx` (copy assertions), `src/identity/fez-persona.ts` (guide paragraph wording: "prompt-style agent plugin" → "skills")
- Test: existing `git_install.rs` tests updated + one new

**Interfaces:**
- Consumes: `fez.skills` install path (Task 2).
- Produces: converted packages carry `fez.skills: {dir: "skills"}` with `skills/<id>.md` files for skill-shaped sources (`skills/*/SKILL.md`, `.claude/skills/*/SKILL.md`, root `SKILL.md`), and keep `fez.personas` for `agents/*.md` only. Skill file emitted as:
  ```markdown
  ---
  name: <frontmatter name or id>
  description: <description or "ported from <owner>/<repo>">
  ---
  <!-- ported from <url> (<sha7>) by fez install-from-chat; edit or delete freely -->

  <original body>
  ```
  `InspectReport` gains `agents: Vec<PersonaFound>` alongside `personas` — rename `personas` to `skills` in the report (TS mock updates with it).

- [ ] **Step 1: Update the Rust tests** — `a_clean_plugin_converts_to_a_persona_pack` becomes `a_clean_plugin_converts_to_a_skill_package`: assert `fez/skills/dir == "skills"`, `tar_read(&npm, "skills/ponytail.md")` starts with `---\nname: ponytail\n`, contains the HTML provenance comment and `Be lazy.`, and that NO `personas/ponytail.md` exists; `bare_skill_and_agents_layouts_are_recognized` asserts `agents/critic.md` still lands as `personas/critic.md` (persona template with `harness:` intro as before) while root SKILL.md lands under `skills/`. Add: a package with only `agents/*.md` still emits `fez.personas` and no `fez.skills`.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement the emission change** in `convert` (discovery/scan/payload logic untouched; manifest synthesis now writes `fez.skills` and/or `fez.personas` per what was found; `fez.permissions` becomes `["personas"]` only when agents exist, else `[]`).
- [ ] **Step 4: Card copy** — InstallOffer.tsx: consent panel lists `skills` (`report.skills`) as `name — description` and agents separately when present (`personas` permission line only shown when agents exist); done state text: `installed — attach it to an agent in its editor`. Update the vitest mocks/assertions (`personas:` key → `skills:`, new done-state string).
- [ ] **Step 5: Guide persona** — fez-persona.ts paragraph: "prompt-style agent plugin (markdown skills …)" phrasing stays accurate; change "shows exactly what's inside" sentence to name skills: `Their desktop shows the skills inside and refuses anything whose skills contain executable code`. Keep the fez-evals text-guard passing (it checks `fez:install git:` + DM-only — unchanged).
- [ ] **Step 6: Run** — cargo full suite; `npx vitest --run packages/fez-desktop/tests packages/fez-evals/tests/fez-persona-git-install.test.ts` → green.
- [ ] **Step 7: Commit** — `git commit -m "install-from-chat: converter emits skill packages; agents stay personas"`

---

### Task 9: Marketplace — skills publishable

**Files:**
- Modify: `src/cli/cmd-skill.ts` (now `fez tool`: `publish --artifact` gains `skill`; `install` handles `artifact === "skill"`), `packages/fez-desktop/src/SkillsView.tsx` (browse filter chips gain `skills`)
- Test: extend the Task 7 test file

**Interfaces:** a `skill` listing's content names a package source (`npm:@scope/pkg` or `git:github.com/o/r`) in the existing listing shape's `installCmd`/source field; installing resolves to a package install (`fez install <source>` path / desktop `install_package`), never an `mcpServers` write.

- [ ] **Step 1: Failing test** — publish-shape unit: build the listing JSON for `--artifact skill` and assert `artifact: "skill"` + source present; install-branch unit: `artifact: "skill"` routes to the package-install path (assert on the resolved action, not a live install — follow how existing cmd-skill tests fake the relay, or test the pure listing-building helper if none do).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** both branches + the browse chip (filter `artifact === "skill"`).
- [ ] **Step 4: Run** the tests → PASS.
- [ ] **Step 5: Commit** — `git commit -m "marketplace: skills publish and install as packages"`

---

### Task 10: End-to-end manual gate

- [ ] **Step 1:** `npm run tauri dev` from the worktree's packages/fez-desktop (kill anything on port 1420 first — leftover dev servers have squatted it twice).
- [ ] **Step 2:** DM @fez `install this https://github.com/DietrichGebert/ponytail` → card shows skills (not personas), install → package lands with `skills/*.md`, NO new @ponytail persona.
- [ ] **Step 3:** Open an agent's editor → skills section lists ponytail → attach → persona file gains `skills: [ponytail]`.
- [ ] **Step 4:** Talk to that agent about a coding task → its spawn prompt lists the skill (verify via the agent actually calling `fez_load_skill`; watch it go lazy).
- [ ] **Step 5:** Sidebar reads `tools` and `artifacts`; `fez tool list` works; `fez skill list` still routes.
- [ ] **Step 6:** No commit — report findings. Release later still owes `e2e-cold-start.sh` on the mini.
