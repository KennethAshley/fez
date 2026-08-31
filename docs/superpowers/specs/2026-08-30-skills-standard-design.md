# Skills, the standard kind — SKILL.md tier + the tools rename

**Date:** 2026-08-30 · **Status:** draft for review · **Scope:** fez
adopts the ecosystem's vocabulary — a *skill* is a SKILL.md instruction
pack an agent loads; what fez called skills (MCP servers) becomes
*tools* — and builds the skill tier: package format, persona attach,
progressive-disclosure runtime, GUI, marketplace. **Not in scope:**
wire/protocol renames (kind 40200/40201 and existing `artifact:` values
keep their names), slash-command porting from foreign plugins, any
always-on injection mode.

## The problem

Ponytail (github.com/DietrichGebert/ponytail) is what the ecosystem
calls a skill: markdown instructions that overlay an agent's behavior —
an adjective, not a noun. fez cannot represent it. fez's "skills" are
MCP servers (tools an agent calls), so the word is taken by the wrong
concept, and the thing users will arrive expecting — Claude/Cursor
skills, installable and attachable to their agents — has no tier. The
agent↔skill binding spec (2026-08-27) saw this and deferred "the
SKILL.md instruction tier"; install-from-chat (2026-08-30) hit it in
practice: a ported ponytail landed as an @ponytail persona, which is a
category error — ponytail-@deployer should be @deployer, lazier.

Pre-public-flip is the cheapest a vocabulary fix ever gets.

## Decisions already made (with Ken, 2026-08-30)

1. **Full user-facing flip now.** Tool = MCP server; skill = SKILL.md
   pack. Every label, toast, and help string flips. Wire constants
   don't.
2. **Progressive disclosure.** Attached skills advertise name +
   description in the prompt; the agent pulls a skill's body on demand
   via a `fez_load_skill` tool (the Claude Code / Buzz `load_skill`
   model). No always-on append; a mode-like skill self-persists via its
   own body once loaded, exactly as ponytail does in Claude Code.
3. **Loom's sidebar surface renames "tools" → "artifacts"**, freeing
   the word for MCP servers.
4. **Frontmatter needs no migration.** `mcpServers:` stays — it is the
   technically accurate name for tools. Skills get a sibling key.

## 1. Vocabulary and the rename

- **tools** (was "skills"): SkillsView's skills page title/legend/
  toasts, SkillPicker's section label, AgentProfile/AgentCard/
  AgentsPane/HoverCard strings, App.tsx nav item, SettingsPane hints,
  `fez skill` CLI → `fez tool` (subcommands unchanged; `fez skill`
  remains a hidden alias for one release), cmd-persona help ("Declares
  tools:"), package-manager/link output ("Defined tool …"), fez-acp's
  capability-honesty bullet, web docs (`concepts/skills.mdx` →
  `concepts/tools.mdx` + a new `concepts/skills.mdx` for the real
  tier), AGENTS.md/ONBOARDING.md.
- **artifacts** (was "tools"): the loom nav item and its view labels.
- **skills**: reclaimed for the new tier everywhere it appears.
- Not renamed: Rust command names (`read_skills`, `write_skill`, …),
  CSS class names (`.skill-row` etc. are layout vocabulary reused by
  non-skill views), `KIND_SKILL_LISTING`/40200/40201, `fez.parts.skill`
  (see §2 note), TS identifiers where rename is pure churn — code-level
  naming follows opportunistically, user-facing strings flip now.

## 2. The skill package

A skill ships as a package (store constraint: everything is a package).

- Manifest: `fez.skills: { dir?: string }` (default `"skills"`), a
  directory of `<id>.md` files. Each file: frontmatter `name` (defaults
  to file stem) and `description` (required — it is what the agent sees
  before loading), then the body. Installed like every part:
  materialized under `~/.fez/packages/<pkg>/<dir>/`, no flat symlink,
  no legacy `~/.fez/skills/` (that dir stays dead). Uninstall removes
  them with the package.
- `fez.parts.skill` (the MCP part) keeps its manifest name for
  back-compat but the docs/comments call it the *tool part*; a
  follow-up may alias `fez.parts.tool`. New packages may carry both a
  tool part and `fez.skills` — one package, both capabilities, one
  attach picker.
- Discovery: a `skillsInstalled()` reader (TS core + Rust mirror where
  the desktop needs it CLI-free) walks `~/.fez/packages/*/package.json`
  for `fez.skills` and returns `{pkg, id, name, description, path}`.

## 3. Persona attach

New frontmatter key, same grammar and security posture as tools:

    skills: [ponytail, review=npm:@fezchat/ponytail]

- Parsed by extending `parseSkillEntries`-style parsing in
  `src/identity/personas.ts` into `skills: string[]` +
  `skillSources: Record<name, source>`. The key joins
  `ALL_KNOWN_KEYS`; `serializePersona` emits it.
- A source names a package (npm:/well-known), never a command or a
  path — `parseSkillSource`'s rules apply unchanged. A bare name
  resolves against installed packages by skill id.
- `skill-attach.ts` grows the same attach/detach for the `skills:`
  line; `agent-skill-health.ts` reports missing skills the way it
  reports missing tools.

## 4. Runtime — progressive disclosure

- **Spawn:** fez-acp resolves the persona's `skills:` against
  `skillsInstalled()`. The per-turn prompt (both channel and DM builds)
  gains one compact section:

      [Skills]
      You have these skills — load one with fez_load_skill when its
      description matches the task; follow a loaded skill until done.
      - ponytail: Forces the laziest solution that actually works…
      - review: …

  Placed beside the memory section (same assembly site); on later
  turns the list rides the standing conventions (no body ever inlined).
- **fez-mcp:** one new tool, `fez_load_skill(name)`. The resolved
  attached set (name → file path) is handed to fez-mcp at spawn the
  way its other per-agent context is; the tool validates the name
  against that set, reads the SKILL.md body, and returns it verbatim. Unknown or
  unattached name → error naming the attached set. No path input, no
  filesystem reach beyond resolved skill files.
- **Missing skills** (declared, not installed) join the existing
  capability-honesty bullet with an install hint, mirroring tools.

## 5. GUI

- The **tools** view is today's skills page, renamed; no structural
  change.
- **Skills appear in the same three attach surfaces** the binding spec
  built: SkillPicker renders two checkbox sections — *skills* (from
  `skillsInstalled()`, writes `skills:`) and *tools* (unchanged, writes
  `mcpServers:`); the installed inventory lists skill packages with
  the same "give to…" flow; the post-install "give it to?" banner
  works for skill installs.
- Browse: skill packages surface in the extension gallery/marketplace
  listings like any package (see §6); no new pane.

## 6. Acquisition and marketplace

- **install-from-chat retargets** (the parked branch): the converter
  emits a skill package — `skills/*/SKILL.md` → `fez.skills` entries
  (frontmatter name/description mapped, intro provenance comment
  prepended as an HTML comment rather than body text), `agents/*.md` →
  personas as built. The consent card says "N skills"; after install
  the card offers the attach picker. The @fez guide paragraph and all
  scan/fetch machinery stand as built.
- **Marketplace:** `fez tool publish` gains `--artifact skill` →
  40200 listings with `artifact: "skill"` naming the package source;
  install resolves to a package install (not an mcpServers write).
  Desktop browse filters gain a skills chip.

## 7. Order of work

1. This spec's tier + rename land first, on their own branch.
2. `install-from-chat` rebases onto it, retargets its converter
   (§6), and both merge together — the end-to-end being: DM @fez a
   GitHub URL → consent card → skill package installs → attach to any
   agent in its editor → that agent loads it when relevant.

## 8. Testing

- Persona parsing: `skills:` round-trips, sources validate, unknown
  names warn (fez-evals, beside the existing skill-source tests).
- Runtime: spawn prompt lists attached skills' name+description and
  never the body; `fez_load_skill` returns an attached body, refuses
  an unattached name (fez-mcp tests).
- Attach surfaces: picker writes `skills:` without disturbing
  `mcpServers:`; give-to on a skill package row (jsdom, existing
  patterns).
- Rename: a grep gate — no user-facing string says "skill" for an MCP
  server; `fez skill` alias still routes.
- Manual: install ponytail from chat, attach to an agent, watch it
  load the skill and go lazy. E2E cold-start gate before any release.

## Open questions

None — resolved with Ken 2026-08-30 (injection mode, rename scope,
loom naming, frontmatter strategy).
