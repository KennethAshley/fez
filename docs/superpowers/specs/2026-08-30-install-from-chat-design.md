# Install from chat — "@fez install <git URL>" → prompt-pack converter

**Date:** 2026-08-30 · **Status:** draft for review · **Scope:** DM the
guide a git URL, get an install card, land the repo's markdown as a
persona pack. **Not in scope:** executable plugins of any kind, the
SKILL.md instruction tier (stays deferred per the agent↔skill binding
spec), channel-wide git-URL cards, the CLI `fez install git:` path,
guide-authored porting, non-GitHub hosts.

## The problem

The world is full of prompt-shaped agent plugins — ponytail
(github.com/DietrichGebert/ponytail) is a 117k-star example that is
nothing but markdown. None of them are fez extensions. Today a fez user
who wants one has two options: be a developer (`fez create` + copy the
files + `fez link`), or wait for someone to publish a port to
`@fezchat/*`. A non-developer's natural move — DM the guide "install
this <URL>" — dead-ends: the guide's persona hardcodes six offerable
catalog names and points at the gallery for everything else.

The goal: **skills and personas arrive through chat.** DM @fez a URL,
confirm on a card, use it. If it exists in the catalog or skill
marketplace the guide offers that first; the git-URL path is the
fallback for "doesn't exist elsewhere."

## Decisions already made (with Ken, 2026-08-30)

1. **Prompt-shaped only.** Markdown + image assets. A repo containing
   anything executable is refused whole.
2. **Deterministic converter.** Code in the install pipeline does the
   fetch/scan/convert. The guide never touches the machine; it only
   emits the same kind of marker it emits today.
3. **DM + gallery surfaces only.** A git-URL card renders in your own
   DM with the guide, or from an "install from URL" box in the
   Extension Gallery. In shared channels the marker stays plain text —
   no card, no button.
4. **Lands as a persona pack.** Each ported skill becomes a persona
   (`~/.fez/personas/*.md`) the user can DM, edit, or delete like any
   other. The converter prepends a short self-introduction to each
   persona. The deferred SKILL.md instruction tier, when it lands,
   re-maps these packages to attachable skills; this spec does not
   build it.

## Flow

1. User DMs @fez: "install this https://github.com/DietrichGebert/ponytail".
2. Guide replies conversationally and emits, on its own line:
   `fez:install git:github.com/DietrichGebert/ponytail`
3. The desktop (DM context only) renders an install card that first
   calls `inspect_git_package(url)`: fetch, scan, report.
4. Card shows: source URL, synthesized package name, what was found
   ("4 skills → 4 personas · commands/ ignored · no executable code"),
   and the standing line that these are instructions that will steer
   your agents.
5. Two clicks (`review & install` → `install & grant`), same as the
   catalog flow. `install_git_package(url)` converts and installs into
   the standard `packages/<name>/` + persona-pack layout.
6. The new personas appear; DM one and it introduces itself.

## Components

### 1. Guide persona (`src/identity/fez-persona.ts`)

One added paragraph to `CAPABLE_FEZ_PERSONA`'s "Offering an extension
install" section: when a user *in a DM* asks to install from a URL,
check the catalog/marketplace first; otherwise emit
`fez:install git:<url>` on its own line, and say plainly that the
desktop will show what the repo contains before anything installs. In
a shared channel, decline and suggest the DM. No new tools; the guide
still cannot install anything.

### 2. Marker parsing (`packages/fez-desktop/src/InstallOffer.tsx`)

`installOffers()` gains a second pattern:
`/fez:install\s+git:(github\.com\/[\w.-]+\/[\w.-]+)(#[\w.\/-]+)?/gi`.
GitHub-only in v1; the host is part of the regex, not user input to a
fetcher. DMs render no install cards at all today (`DmView` renders
raw markdown), which gives the surface gate for free: the git card
component mounts **only in `DmView`** (1:1 conversations, not group
DMs) — channels keep the `@fezchat/*`-only card and never learn the
git pattern. The existing `@fezchat/*` behavior is untouched.

### 3. Fetch + scan (`packages/fez-desktop/src-tauri`)

Two new Tauri commands beside `install_package`:

- `inspect_git_package(url, ref?) → InspectReport` — resolve
  `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>` (default
  ref: the repo's default branch via the public GitHub API; both hops
  https-only), download under the existing `MAX_TGZ`/`MAX_TAR` caps,
  untar in memory (reuse the `install_package` tar machinery), then
  scan every entry:
  - **Only `.md` files ever install** — the converter authors the
    installed package itself, so images, JSON manifests, LICENSE
    files etc. are simply never copied; they're listed as "ignored"
    on the card, not a risk.
  - **Code refuses the whole repo:** any `.js/.ts/.mjs/.cjs/.sh/.py/
    .rb/.ps1` file, a `hooks/` dir, or an MCP server config marks the
    repo **refused**, with the offending paths named in the report. No
    partial installs: stripping the code out of a plugin that needs it
    would ship a silently broken pack.
  - The report lists what would install (skill/persona files found,
    per the mapping below), what would be ignored, the resolved commit
    sha, and the synthesized package name.
- `install_git_package(url, ref?) → InstallReport` — re-fetch (or
  reuse the inspected bytes if still cached), re-scan (the scan is the
  gate, both commands run it), convert, then hand the synthesized
  package to the existing `install_from_tarball` path so placement,
  path-escape refusal (`materialize()`), persona validation, and the
  symlink index are all the code that already runs today.

The pinned sha goes into the recorded grant alongside the source URL.

### 4. Converter (same crate, pure function)

Recognized layouts, checked in order:

| found | mapped |
| --- | --- |
| `skills/<name>/SKILL.md` (Claude plugin layout, incl. `.claude/skills/`) | one persona per skill, named `<name>` |
| `SKILL.md` at repo root (bare-skill repo) | one persona named after the repo |
| `agents/<name>.md` | one persona per file |
| `commands/*.md`, `README*`, everything else allowed | ignored, listed on the card |

Nothing recognized → refuse with "no skills or personas found."

Per persona: SKILL.md frontmatter `name`/`description` map to persona
frontmatter; unknown frontmatter keys are dropped (the persona
validator already rejects unknown fields). The converter prepends a
short intro section to the body: what this persona is, the source repo
URL and commit, and that the file lives in `~/.fez/personas/<name>.md`
to edit or delete freely. The original body follows unmodified.

Synthesized manifest: name `gh-<owner>-<repo>` (normalized to the
existing charset rules — the `gh-` namespace cannot collide with or
impersonate `@fezchat/*`), `fez.type: "persona-pack"`,
`fez.personas: {dir}`, `fez.permissions: ["personas"]`,
`fez.gitSource: {url, sha}` recorded in the manifest itself. Each
persona is stamped `harness: claude-code` frontmatter (the persona
installer skips files without a `harness:` key). A persona file that
already exists is kept, not overwritten — existing persona-pack
behavior.

### 5. Gallery URL box (`packages/fez-desktop/src/ExtensionGallery.tsx`)

A single input at the bottom of the gallery: paste a GitHub URL →
`inspect_git_package` → the same card component → the same install
call. No browsing, no search, no curation implied.

## Consent card

Reuses `InstallOffer`'s two-click structure. Differences from a
catalog card: the source line shows the full URL + short sha; the
contents line comes from the InspectReport, not a curated blurb; a
fixed line reads "These are instructions that will steer agents you
run. Installs on THIS machine." A refused repo renders the refusal
reasons where the install button would be — there is deliberately no
button to override the scan.

## Updates

None automatic. Re-running the install re-fetches the default branch,
but the persona installer **keeps any file that already exists** — so
user edits are never clobbered; a genuine upstream update requires
deleting the persona file first, and the card says so when the package
is already present. The recorded sha makes "what changed" answerable
later; v1 ships no diff UI.

## Security model, summarized

- No `git` binary, no clone, no shell: https tarball via the same
  `ureq` + caps as `install_package`.
- Allowlist scan; refusal is whole-repo; scan runs in both inspect and
  install (inspect is UX, the install-side scan is the gate).
- Cards only where the user initiated the ask (own DM / gallery) — a
  hostile agent in a channel cannot render an install button.
- `gh-*` namespace separation; existing charset, path-escape, size,
  and persona-validation gates all inherited by construction.
- Residual risk, accepted and stated on the card: prompt injection via
  installed instructions. Identical in class to installing any persona
  pack or skill; mitigations (persona validation, no tool grants —
  a persona pack carries no mcpServers, no bins, no code) apply.

## Testing

- Fixture tarballs in the Rust tests beside `package_install.rs`:
  a clean Claude-plugin layout, a bare SKILL.md repo, one with a
  smuggled `.js`, one with `package.json` scripts, one with a path
  escape, one with nothing recognizable. Assert
  inspect/refuse/convert output for each.
- Converter unit tests: frontmatter mapping, intro prepending, name
  normalization, persona collision refusal.
- `InstallOffer` test: git marker renders a card in the guide DM,
  plain text elsewhere (extend `packages/fez-desktop/tests`).
- Guide persona: a text-level guard in fez-evals asserting the persona
  keeps teaching the git marker form and its DM-only rule (a behavioral
  agent eval is optional follow-up, not v1).
- E2E gate: `e2e-cold-start.sh` on the mini stays the ship gate for
  any desktop release carrying this.
