# Agent ↔ skill binding — package identity, three attach surfaces, no silent failures

**Date:** 2026-08-27 · **Status:** draft for review · **Scope:** skill identity in the machine catalog, GUI attach in both directions, visible failures at spawn. **Not in scope:** the Qud-style agent creation wizard (deferred), the SKILL.md instruction tier (deferred), auto-install from a persona file (settled no).

## The problem

A GUI-only user cannot connect a skill to an agent without typing a
string from memory.

Getting a skill works: Skills tab → browse → `install…` → the
definition lands in `~/.fez/settings.json → mcpServers`. Attaching it
does not. The only mechanism is a free-text input in the persona editor
labelled "skills / mcpServers (comma-separated)"
(`PersonaEditor.tsx:193`) — a plain `<input>` with no dropdown, no
autocomplete, no validation, and no list of what is installed. The
install toast tells you to go do it: *"declare it in a persona
(mcpServers) and it loads on next spawn."*

The string you must type is a **key in your own local settings file**,
not a package name. So the same package answers to different names
depending on how it arrived:

| install route | resulting name |
| --- | --- |
| `fez install npm:@fezchat/wallet` | `wallet` (`npmPackageName` strips the scope) |
| `fez link packages/fez-wallet` | `fez-wallet` (`path.basename(pkgDir)`) |

Live evidence on the author's machine — `@scout` declares
`mcpServers: [bittensor, fez-wallet]`, which mixes both conventions in
one line, and both entries point at
`/Users/ken/Projects/fez/packages/…`. That agent works on exactly one
computer, and installing its two packages from npm would break half of
it silently. Two other personas (`@deployer` → `docker`,
`@researcher` → `github`) name skills that do not exist at all; both
spawn anyway, quietly reduced.

## What already exists

Most of the mechanism is built and unused.

`src/extensions/skill-source.ts` defines a portable declaration form —
`mcpServers: [wallet=npm:@fezchat/wallet]` — already parsed by
`parseSkillEntries` (`personas.ts:93`), already reasoned about. Its
header comment states the goal exactly: *"the persona becomes portable:
hand it to someone and their fez knows exactly what to fetch."* It also
fixes the security posture: a source spec names a **published package
or URL, never a command**, so a persona arriving over the wire cannot
smuggle arbitrary code through a frontmatter key.

Nothing writes that form except the repair path. `rememberSource`
(`SkillsView.tsx:656`) writes `name=source` back into a persona after
you have resolved a dead reference — so fez already knows how to make a
persona portable, but only *after* the mistake.

Also present and reusable: `describePermission`
(`extension-permissions.ts:86`) turns a package's declared permissions
into human-readable, sensitivity-flagged lines; persona listings on the
wire already carry `requiredSkills`, rendered as `needs: wallet ✓`; and
`fez.personas` persona packs already merge pack-level `defaults` under
each persona's frontmatter.

So this is plumbing and surfaces, not a new format.

### Note on Buzz

Buzz was the reference for this design and does **not** solve it.
`.persona.md` has an `mcp_servers:` field, but it inlines the full
literal command plus secret values (`persona.rs:373`:
`command: npx`, `env: {TOKEN: abc123}`). It is not validated
(`validate.rs` never checks those commands) and it is **not consumed** —
the only reference outside the persona crate is
`buzz-cli/src/commands/pack.rs:115`, which prints a count. Real MCP
wiring in `buzz-acp` is `build_mcp_servers(&config)`, a single
operator-level `config.mcp_command`. Buzz's shape is also the one fez
explicitly refused, for the code-execution reason above.

Two things worth taking from Buzz, both noted and one adopted here:
its `SKILL.md` + `load_skill` instruction tier (real, wired, genuinely
absent from fez — **deferred**), and `deny_unknown_fields` on the
frontmatter parser (**adapted** in section 3).

## 1. Skill identity

A settings entry currently records only how to *run* something:

```json
"fez-wallet": {
  "command": "node",
  "args": ["/Users/ken/Projects/fez/packages/fez-wallet/dist/mcp.js"]
}
```

It does not record **what package that is**, or anything a picker could
display. Four optional fields are written at install/link time:

```json
"fez-wallet": {
  "command": "node",
  "args": ["…/dist/mcp.js"],
  "package": "@fezchat/wallet",
  "source": "npm:@fezchat/wallet",
  "description": "per-agent allowance wallets — pay and receive TAO",
  "local": true
}
```

- **`package`** — the canonical id, from the installed package's own
  `package.json` `name`. Identical on every machine regardless of the
  local key.
- **`source`** — the spec that reinstalls it; feeds the `=source` form
  the GUI writes.
- **`description`** — one line for the picker, so a checklist entry
  means something. Taken from the package's `description`, or from the
  relay listing when the skill was installed from one (listings already
  carry a description; `InstallDialog` has it in hand and currently
  discards it). Absent for a hand-rolled skill, which renders as the
  name alone.
- **`local`** — true when the entry came from `fez link` and its
  command points into a working tree. The GUI already refuses to
  publish these by string-matching the command (`SkillsView.tsx:508`);
  this makes the condition data.

All four are optional. A hand-rolled skill
(`fez skill add myserver --command …`) has no package and stays valid —
local names are a legitimate category, not a legacy to migrate off.

### Resolution order

When a persona declares a skill, the resolver tries, in order:

1. an entry whose **key** matches the declared name (today's behaviour, unchanged);
2. an entry whose **`source`** matches the declared `=source` spec;
3. an entry whose **`package`** matches the package the `=source` spec names.

Step 3 is the fix: `wallet` and `fez-wallet` both carry
`package: "@fezchat/wallet"`, so a persona declaring
`wallet=npm:@fezchat/wallet` resolves against either. Existing personas
that declare a bare name keep working via step 1, so nothing breaks and
no migration is required.

The resolver is one shared module, called by both the spawn path
(`fez-acp`) and the GUI (via a Tauri command). The CLI/GUI split is
what produced two names for one package; a single resolver is what
stops it recurring.

## 2. Three attach surfaces

All three perform the same write: add or remove one entry in a
persona's `mcpServers` line, always in the portable `name=source` form.
The write reuses `rememberSource`, which already does exactly this.

**Agent editor** (`PersonaEditor.tsx:193`) — the free-text input
becomes a checklist of installed skills with their descriptions:

```
skills
 [x] wallet      pay and receive TAO
 [x] bittensor   find subnets by capability
 [ ] obsidian    read and write notes
 [ ] polls       run channel polls

 [+ browse more skills…]        → Skills tab
```

Skills the persona names but that are not installed still appear,
marked missing, with the existing FindSource repair button.

**Skill row** (`SkillsView.tsx`, installed tab) — the reverse view, so
one screen answers "who can spend money":

```
wallet          pay and receive TAO
 used by @scout, @vault          [give to…]
```

**Install dialog** — closes the loop rather than instructing the user
to go elsewhere. Replaces the current terminal toast:

```
✓ installed wallet
give it to?   [@scout]  [@vault]  [@fez]  [not now]
```

**Supporting seam:** one Tauri command listing installed skills with
`package`, `description`, and `local`, so the picker has something to
render. The picker is built as a standalone component — a deferred
agent-creation wizard should be able to drop it in unchanged.

**Persistent, not a toast:** attaching a skill takes effect on next
spawn. A running agent that was just given a wallet does not have one
yet. The picker states this in place; a toast that vanishes is not
adequate for a fact the user needs while deciding.

## 3. No silent failures

**Missing skills appear next to the agent.** A dead reference currently
prints a console warning nobody reads and the agent spawns regardless.
The agent list already knows each persona's skills:

```
@researcher   ⚠ missing: github
```

with the repair button. Same data as the Skills tab's missing section,
surfaced where it is noticed.

**Dev-tree skills are flagged.** With `local: true` recorded:

```
@scout   ⚠ 2 skills point at your dev tree — won't work elsewhere
```

**Near-miss frontmatter keys warn.** `parseFrontmatter`
(`personas.ts:118`) sweeps unknown keys into `extra`, so `mcpServer:`
instead of `mcpServers:` yields an agent with no skills and no
complaint. fez cannot reject unknown keys outright — extensions
legitimately add them — so it warns when an unknown key is within an
edit distance of 2 of a known one (`mcpServer` → `mcpServers`, distance
1). The key is still kept in `extra`; the warning is advisory, never a
rejection. Catches the realistic typo without breaking extensions.

## Migration

None required, by construction. Local names keep resolving via step 1
forever. Canonical `package` ids are additive metadata written on new
installs; existing entries acquire them on next install/update, or on
demand from the repair path. The GUI flags agents on a local-only name
or a dev-tree path and offers one-click repair through the existing
FindSource/`rememberSource` machinery. Nothing rewrites a persona
without the user asking.

## Testing

- **Resolution order** — unit tests over the three steps, including the
  case this exists for: persona declares `wallet=npm:@fezchat/wallet`,
  catalog key is `fez-wallet`, resolves by `package`.
- **Hand-rolled skills** — an entry with no `package`/`source` still
  resolves by name; nothing warns about it.
- **Write round-trip** — attach and detach through each of the three
  surfaces produce identical frontmatter; unknown frontmatter keys and
  hand-written formatting survive the round-trip (the existing
  PersonaEditor contract).
- **Typo warning** — `mcpServer:` warns; an extension key like
  `shareLevel:` does not.
- **Dev-tree flag** — a linked package's entry records `local: true`
  and the agent row says so.

## Deferred

- **Agent creation wizard** (Qud-style: harness → archetype → skills →
  attributes → character sheet). The mutation-screen framing maps well
  onto the skill picker with `describePermission` output as the cost
  line, and `+ new agent` currently offers no skills at all
  (`AgentsPane.tsx:706`). Revisit once the picker component exists.
- **SKILL.md instruction tier** — Buzz's `load_skill` progressive
  disclosure. A genuine gap; a separate subsystem.
- **Agent-facing discovery** — letting an agent see installed-but-
  unattached skills and request one. Owner-side only for now.
