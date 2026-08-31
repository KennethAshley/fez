# Install from Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DM @fez a GitHub URL of a prompt-shaped plugin (markdown skills, e.g. ponytail), get a consent card, and install it as an editable persona pack — no CLI, no code execution.

**Architecture:** A pure-Rust converter scans a GitHub tarball, refuses anything with code, and synthesizes an npm-shaped tarball (personas + package.json) that flows through the existing `install_from_tarball` path — every existing gate (path escape, emptiness, persona keep-user-copy) runs by construction. Two new Tauri commands (`inspect_git_package`, `install_git_package`) front it. The card renders only in `DmView` (which today renders no cards at all) plus a URL box in the Extension Gallery; channels never learn the git marker.

**Tech Stack:** Rust (tar, flate2, ureq, serde_json — all already in src-tauri), React/TS (fez-desktop), vitest (root runner), cargo test.

**Spec:** `docs/superpowers/specs/2026-08-30-install-from-chat-design.md`

## Global Constraints

- GitHub only: the marker/URL regex hard-codes `github.com/<owner>/<repo>` (+ optional `#ref`). No other hosts.
- No `git` binary, no shell, no npm: https tarball via `ureq`, caps `MAX_TGZ = 30MB` gz / `MAX_TAR = 120MB` expanded (same values as `install_package`).
- Only `.md` content ever installs. Any `.js/.ts/.mjs/.cjs/.sh/.py/.rb/.ps1` file or `hooks/` dir refuses the WHOLE repo. No partial installs.
- Synthesized package name: `gh-<owner>-<repo>`, lowercased, chars outside `[a-z0-9-]` replaced with `-`.
- Each generated persona gets `harness: claude-code` frontmatter (the installer skips files without `harness:`) and a prepended intro section naming the source URL + sha and the file's editable location.
- Existing persona files are never overwritten (existing `install_from_tarball` behavior — do not change it).
- Channel rendering (`Bubble`) and the `@fezchat/*` marker behavior are untouched.
- Commit messages: plain, no co-author or session trailers.

---

### Task 1: Rust converter — scan a GitHub tarball, synthesize an npm-shaped package

**Files:**
- Create: `packages/fez-desktop/src-tauri/src/git_install.rs`
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (add `mod git_install;` next to the existing `mod package_install;`)

**Interfaces:**
- Consumes: `tar::Archive`, `tar::Builder` (tar crate already a dependency of package_install.rs).
- Produces (Task 2 relies on these exact shapes):

```rust
#[derive(serde::Serialize, Clone)]
pub(crate) struct InspectReport {
    pub name: String,               // "gh-dietrichgebert-ponytail"
    pub personas: Vec<PersonaFound>,// what will install
    pub ignored: Vec<String>,       // non-md paths, listed on the card
    pub refused: Vec<String>,       // offending paths; non-empty = refused
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct PersonaFound {
    pub id: String,          // persona file stem, e.g. "ponytail"
    pub description: String, // from SKILL.md frontmatter, may be ""
}

/// Scan a GitHub tarball (tar bytes, root prefix "<repo>-<ref>/") and, if
/// clean, build an npm-shaped tarball ("package/..." prefix) containing
/// personas/<id>.md files + a synthesized package.json.
/// Ok((report, Some(npm_tar))) = installable; Ok((report, None)) = refused
/// (report.refused names why); Err = malformed archive / nothing recognized.
pub(crate) fn convert(
    tar_bytes: &[u8],
    owner: &str,
    repo: &str,
    url: &str,
    sha: &str,
) -> Result<(InspectReport, Option<Vec<u8>>), String>
```

**Implementation notes (read before coding):**

- GitHub tarballs prefix every entry with one root dir (`<repo>-<ref>/`). Strip the first path component of every entry before matching; entries without a `/` (the root dir itself) are skipped.
- Skill discovery, matched against the stripped path, first hit per id wins:
  - `skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md` → persona id `<name>`
  - `SKILL.md` at root → persona id = normalized repo name
  - `agents/<name>.md` → persona id `<name>`
- Refusal check runs over EVERY entry (stripped path): extension in `js|ts|mjs|cjs|sh|py|rb|ps1` (case-insensitive) or any path component `hooks` → push the path into `refused`. Collect all, don't stop at the first.
- Every other non-matching file path goes into `ignored` (cap the list at 20 entries, then push `"… and N more"` — the card shouldn't scroll).
- Frontmatter: if the skill body starts with `---\n`, take lines until the closing `---`; extract `name:` and `description:` by line prefix (trim, strip surrounding quotes). No YAML dependency. The persona body = everything after the closing `---` (or the whole file if no frontmatter).
- Generated persona file content, exactly this shape:

```markdown
---
harness: claude-code
description: <description or "ported from <owner>/<repo>">
---

> Ported from <url> (<sha[0..7]>) by fez install-from-chat.
> This file is yours: edit or delete it at ~/.fez/personas/<id>.md.
> Reinstalling never overwrites your edits.

<original body>
```

- `id` normalization: lowercase, chars outside `[a-z0-9-]` → `-` (matches `tar_list_md` lowercasing).
- Synthesized `package.json` (serde_json, then `to_vec_pretty`):

```json
{
  "name": "gh-<owner>-<repo>",
  "version": "0.0.0-<sha[0..7]>",
  "fez": {
    "type": "persona-pack",
    "permissions": ["personas"],
    "personas": { "dir": "personas" },
    "gitSource": { "url": "<url>", "sha": "<sha>" }
  }
}
```

- Build the npm tarball with `tar::Builder` over a `Vec<u8>`: for each file append a header (`tar::Header::new_gnu()`, set size + mode 0644, `set_cksum()`) at path `package/package.json` and `package/personas/<id>.md`. Return the raw tar bytes (NOT gzipped — `install_from_tarball` takes tar bytes).
- If `refused` is non-empty return `(report, None)` — still fill `personas`/`ignored` so the card can say what it *would* have installed. If no skills/agents/SKILL.md found at all, `Err("no skills or personas found in <owner>/<repo>")`.

- [ ] **Step 1: Write the failing tests**

In `git_install.rs`, a `#[cfg(test)] mod tests` block. Build fixture tars in-test with `tar::Builder` (same style as `fixture_tar()` in `package_install.rs:517`), using root prefix `ponytail-main/`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn gh_tar(files: &[(&str, &str)]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (path, content) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(content.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, format!("ponytail-main/{path}"), content.as_bytes()).unwrap();
        }
        b.into_inner().unwrap()
    }

    const SKILL: &str = "---\nname: ponytail\ndescription: lazy senior dev\n---\n\nBe lazy.\n";

    #[test]
    fn a_clean_plugin_converts_to_a_persona_pack() {
        let tar = gh_tar(&[
            ("skills/ponytail/SKILL.md", SKILL),
            ("skills/review/SKILL.md", "No frontmatter body.\n"),
            ("README.md", "readme"),
            ("LICENSE", "mit"),
        ]);
        let (report, npm) = convert(&tar, "DietrichGebert", "ponytail", "https://github.com/DietrichGebert/ponytail", "abcdef1234567890").unwrap();
        assert!(report.refused.is_empty());
        assert_eq!(report.name, "gh-dietrichgebert-ponytail");
        let ids: Vec<_> = report.personas.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["ponytail", "review"]);
        assert_eq!(report.personas[0].description, "lazy senior dev");
        let npm = npm.expect("clean repo must produce a tarball");
        let pkg = crate::package_install::tar_read(&npm, "package.json").unwrap();
        let pkg: serde_json::Value = serde_json::from_slice(&pkg).unwrap();
        assert_eq!(pkg.pointer("/fez/type").unwrap(), "persona-pack");
        assert_eq!(pkg.pointer("/fez/gitSource/sha").unwrap(), "abcdef1234567890");
        let persona = String::from_utf8(crate::package_install::tar_read(&npm, "personas/ponytail.md").unwrap()).unwrap();
        assert!(persona.starts_with("---\nharness: claude-code\n"));
        assert!(persona.contains("Ported from https://github.com/DietrichGebert/ponytail (abcdef1)"));
        assert!(persona.contains("Be lazy."));
        assert!(!persona.contains("name: ponytail"), "skill frontmatter must not leak into the body");
    }

    #[test]
    fn any_code_file_refuses_the_whole_repo() {
        let tar = gh_tar(&[
            ("skills/ponytail/SKILL.md", SKILL),
            ("hooks/evil.js", "x"),
            ("scripts/setup.sh", "x"),
        ]);
        let (report, npm) = convert(&tar, "a", "b", "u", "s").unwrap();
        assert!(npm.is_none());
        assert_eq!(report.refused.len(), 2);
        assert!(report.refused.iter().any(|p| p.contains("evil.js")));
    }

    #[test]
    fn bare_skill_and_agents_layouts_are_recognized() {
        let tar = gh_tar(&[("SKILL.md", SKILL), ("agents/critic.md", "You are a critic.\n")]);
        let (report, npm) = convert(&tar, "o", "ponytail", "u", "s").unwrap();
        let ids: Vec<_> = report.personas.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"ponytail") && ids.contains(&"critic"));
        assert!(npm.is_some());
    }

    #[test]
    fn a_repo_with_nothing_recognizable_errs() {
        let tar = gh_tar(&[("README.md", "hi")]);
        assert!(convert(&tar, "o", "r", "u", "s").is_err());
    }

    #[test]
    fn converted_pack_installs_through_the_real_installer() {
        let tar = gh_tar(&[("skills/ponytail/SKILL.md", SKILL)]);
        let (_, npm) = convert(&tar, "o", "ponytail", "u", "abcdef1234").unwrap();
        let home = tempfile::tempdir().unwrap();
        let outcome = crate::package_install::install_from_tarball("gh-o-ponytail", &npm.unwrap(), "0.0.0-abcdef1", home.path()).unwrap();
        assert!(outcome.installed.iter().any(|l| l.contains("persona @ponytail")));
        assert!(home.path().join("personas/ponytail.md").exists());
    }
}
```

(If `tempfile` isn't already a dev-dependency of src-tauri, check `package_install.rs` tests — they create temp dirs somehow; use the same mechanism.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fez-desktop/src-tauri && cargo test git_install`
Expected: compile error — `convert` not defined. Add `mod git_install;` to lib.rs first, then the stub types; the tests should fail on the unimplemented body, not on wiring.

- [ ] **Step 3: Implement `convert` per the notes above**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-desktop/src-tauri && cargo test`
Expected: all `git_install` tests PASS, all existing `package_install` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src-tauri/src/git_install.rs packages/fez-desktop/src-tauri/src/lib.rs
git commit -m "git install: converter scans a GitHub tarball, refuses code, emits a persona pack"
```

---

### Task 2: Tauri commands — inspect_git_package / install_git_package

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (new commands + a `finish_install` extraction from `install_package`; register both commands in the `invoke_handler` list at ~line 2318)
- Modify: `packages/fez-desktop/src-tauri/src/git_install.rs` (URL parsing + fetch live here, commands stay thin)

**Interfaces:**
- Consumes: `git_install::convert` (Task 1), `package_install::install_from_tarball`, existing `update_settings` / `obj_entry` / `fez_home` in lib.rs.
- Produces (Task 3 invokes these):
  - `inspect_git_package(url: String) -> Result<String, String>` — JSON of `InspectReport` plus `"sha"`, `"url"`, and `"installed": bool` (whether `packages/<name>/` already exists, via `package_install::installed_manifest`).
  - `install_git_package(url: String) -> Result<String, String>` — human-readable success line, same shape as `install_package`'s.

**Implementation notes:**

- URL parsing in `git_install.rs`:

```rust
/// Accepts "github.com/o/r", "https://github.com/o/r", optional "#ref".
/// Returns (owner, repo, Option<ref>). No regex crate needed — split on '#',
/// strip the scheme and "github.com/" prefixes, then split on '/'.
pub(crate) fn parse_github_url(url: &str) -> Result<(String, String, Option<String>), String>
```
  Validate owner/repo against `[A-Za-z0-9_.-]+` and refuse anything else (including empty, a third path segment, or `..`). Strip a trailing `.git`.
- Fetch in `git_install.rs`, `pub(crate) fn fetch(owner, repo, want_ref) -> Result<(Vec<u8> /*tar*/, String /*sha*/), String>`:
  1. If no ref: GET `https://api.github.com/repos/<o>/<r>` (ureq, 30s timeout, header `User-Agent: fez-desktop`) → `default_branch`. GitHub API requires a User-Agent; without it you get 403.
  2. GET `https://api.github.com/repos/<o>/<r>/commits/<ref>` → `sha` field.
  3. GET `https://codeload.github.com/<o>/<r>/tar.gz/<sha>` — download with the exact `MAX_TGZ`/`MAX_TAR` take-and-check pattern from `install_package` (lib.rs:855-881); copy that pattern, don't reference it.
  Fetching by sha (not branch name) makes inspect and install see identical bytes.
- Extract `fn finish_install(name: &str, tar_bytes: &[u8], version: &str) -> Result<String, String>` from `install_package`'s tail (lib.rs:899-941: `fez_home` → `install_from_tarball` → the `update_settings` folding → the `Ok(format!(...))`). `install_package` becomes resolve+download+compat-gate then `finish_install(&name, &tar_bytes, latest)`. Behavior identical — the existing cargo tests and a manual gallery install must still pass.
- `install_git_package`: parse → fetch → `convert` → if refused, `Err` listing `report.refused` → else `finish_install(&report.name, &npm_tar, &format!("0.0.0-{}", &sha[..7]))`.
- `inspect_git_package`: parse → fetch → `convert` → serialize report + `sha` + `url` + `installed` into one JSON object (no error on refused — the report IS the answer).

- [ ] **Step 1: Write the failing tests** (in `git_install.rs` tests mod)

```rust
#[test]
fn github_urls_parse_and_bad_ones_refuse() {
    assert_eq!(parse_github_url("https://github.com/A-b/c.d#v1").unwrap(),
        ("A-b".into(), "c.d".into(), Some("v1".into())));
    assert_eq!(parse_github_url("github.com/o/r.git").unwrap(), ("o".into(), "r".into(), None));
    for bad in ["gitlab.com/o/r", "github.com/o", "github.com/o/r/extra", "github.com/../r", ""] {
        assert!(parse_github_url(bad).is_err(), "{bad} should refuse");
    }
}
```

- [ ] **Step 2: Run to verify it fails** — `cargo test git_install` → `parse_github_url` not defined.

- [ ] **Step 3: Implement** `parse_github_url`, `fetch`, `finish_install` extraction, both commands; register `inspect_git_package, install_git_package` in the `invoke_handler` list.

- [ ] **Step 4: Run all Rust tests** — `cd packages/fez-desktop/src-tauri && cargo test`
Expected: PASS, including every pre-existing test (the `finish_install` refactor must not move behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src-tauri/src/git_install.rs packages/fez-desktop/src-tauri/src/lib.rs
git commit -m "git install: inspect/install commands fetch by sha through the shared install tail"
```

---

### Task 3: Git marker + card in DMs

**Files:**
- Modify: `packages/fez-desktop/src/InstallOffer.tsx`
- Modify: `packages/fez-desktop/src/App.tsx` (DmView, ~line 2444-2465)
- Test: `packages/fez-desktop/tests/git-install-offer.test.tsx`

**Interfaces:**
- Consumes: `inspect_git_package` / `install_git_package` (Task 2 JSON shapes).
- Produces:
  - `gitInstallOffers(content: string): string[]` — deduped URLs from `fez:install git:…` markers.
  - `stripInstallMarkers(content)` — now also strips the git form.
  - `<GitInstallOffer url={string} authorName={string} client={FezClient} />` — exported from InstallOffer.tsx.

**Implementation notes:**

- Marker: `const GIT_MARKER = /fez:install\s+git:((?:https:\/\/)?github\.com\/[\w.-]+\/[\w.-]+(?:#[\w./-]+)?)/gi;` — mirror the shape of `MARKER`/`installOffers` (InstallOffer.tsx:12-18). Extend `stripInstallMarkers` with two `.replace` lines for the git form, mirroring lines 23-24.
- `GitInstallOffer` component, state machine in one `useState<Phase>`:
  `idle → inspecting → report(InspectReport+sha+installed) | error(string) → installing → done`.
  - idle: same card chrome as `InstallOffer` (`install-offer` classes, `AnimatedSprite` via `generateArtifact(url)`), title `{authorName} suggests installing from {url}`, button `review & install` → invoke `inspect_git_package`.
  - report, not refused: consent panel (`install-offer-consent` classes) listing `report.personas` (`@id — description`), the ignored list, the permission line `⚠ read & edit agent personas` (`personas` is in `SENSITIVE`), the fixed line **"These are instructions that will steer agents you run. Installs on THIS machine."**, and — when `installed` — "already installed; existing persona files are kept, your edits survive." Buttons: cancel / `install & grant` → invoke `install_git_package` → `flash`, dispatch `fez-extensions-changed` (mirror `run()` at InstallOffer.tsx:60-73; no `reloadGuiExtensions` needed — persona packs have no gui part).
  - report, refused: `install-offer unknown` styled block: "⚠ contains executable code — not installable as a prompt pack:" + refused paths. No install button, ever.
- DmView (App.tsx): in the message map, change line 2461 to strip markers and mount cards below the body — 1:1 conversations only (`!group`):

```tsx
<div className="bubble-body md"><MdBody text={stripArtifactMarkers(stripInstallMarkers(msg.text))} /></div>
{!group && gitInstallOffers(msg.text).map((url) => (
  <GitInstallOffer key={url} url={url} authorName={client.displayName(msg.senderPk)} client={client} />
))}
```
  Add the imports to App.tsx's existing InstallOffer import line (line 39).
- Do NOT touch `Bubble` / channel rendering: channels keep `installOffers` only, so a git marker in a channel renders as plain text after this task only in DMs is it live. (`stripInstallMarkers` in Bubble will now also strip the git marker text in channels — that's fine, the marker line disappears but no card appears, matching the spec's "no button in channels".)

- [ ] **Step 1: Write the failing tests**

`packages/fez-desktop/tests/git-install-offer.test.tsx`, jsdom + act pattern copied from `mount-point.test.tsx` (its header comment block included). Mock tauri before importing the component:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { gitInstallOffers, stripInstallMarkers, GitInstallOffer } from "../src/InstallOffer";

describe("git install markers", () => {
  it("finds github urls and nothing else", () => {
    expect(gitInstallOffers("hi\nfez:install git:github.com/a/b\n")).toEqual(["github.com/a/b"]);
    expect(gitInstallOffers("fez:install git:gitlab.com/a/b")).toEqual([]);
    expect(gitInstallOffers("fez:install @fezchat/polls")).toEqual([]);
  });
  it("strips both marker forms", () => {
    const s = stripInstallMarkers("x\nfez:install git:github.com/a/b\nfez:install @fezchat/polls\ny");
    expect(s).not.toContain("fez:install");
    expect(s).toContain("x");
  });
});

describe("GitInstallOffer", () => {
  afterEach(() => vi.clearAllMocks());
  it("inspect result renders consent; refusal renders no install button", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify({
      name: "gh-a-b", personas: [], ignored: [], refused: ["hooks/evil.js"], sha: "s", url: "u", installed: false,
    }));
    const div = document.createElement("div");
    document.body.append(div);
    const root = createRoot(div);
    await act(async () => root.render(<GitInstallOffer url="github.com/a/b" authorName="fez" client={{} as never} />));
    await act(async () => { div.querySelector("button")!.click(); });
    expect(div.textContent).toContain("evil.js");
    expect([...div.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("install & grant");
    act(() => root.unmount());
    div.remove();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest --run packages/fez-desktop/tests/git-install-offer.test.tsx` (from repo root)
Expected: FAIL — `gitInstallOffers` is not exported.

- [ ] **Step 3: Implement** marker fns + `GitInstallOffer` + the DmView mount.

- [ ] **Step 4: Run** the new test file, then the whole desktop test dir: `npx vitest --run packages/fez-desktop/tests`
Expected: PASS (playwright e2e specs under tests/e2e are excluded from vitest — known noise if they appear, ignore).

- [ ] **Step 5: Commit**

```bash
git add packages/fez-desktop/src/InstallOffer.tsx packages/fez-desktop/src/App.tsx packages/fez-desktop/tests/git-install-offer.test.tsx
git commit -m "dm install cards: fez:install git: markers render a scan-gated consent card, DMs only"
```

---

### Task 4: Gallery "install from URL" box

**Files:**
- Modify: `packages/fez-desktop/src/ExtensionGallery.tsx`

**Interfaces:**
- Consumes: `GitInstallOffer` (Task 3).

- [ ] **Step 1: Add the box.** At the bottom of the gallery's root render (after the catalog cards, inside the same container the `return (` at ~line 205 opens): a small form — `useState` for the input value and a `submitted` URL —

```tsx
<div className="gallery-from-url">
  <div className="settings-hint">install a prompt pack from GitHub — markdown skills only, repos with code are refused</div>
  <form onSubmit={(e) => { e.preventDefault(); if (/^(https:\/\/)?github\.com\/[\w.-]+\/[\w.-]+/.test(urlDraft.trim())) setSubmitted(urlDraft.trim()); }}>
    <input value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} placeholder="github.com/owner/repo" />
    <button className="mini" type="submit">inspect</button>
  </form>
  {submitted && <GitInstallOffer url={submitted} authorName="you" client={client} />}
</div>
```

Use whatever the gallery's existing prop name for the client is (check `ExtensionGallery`'s props at line 27; pass it through like the catalog install path does). Style: reuse existing classes; add a `.gallery-from-url { margin-top: … }` rule in App.css only if it renders cramped — no new visual system.

- [ ] **Step 2: Typecheck + tests.** `npx tsc --noEmit -p packages/fez-desktop` (or the package's existing check script) and `npx vitest --run packages/fez-desktop/tests`.
Expected: clean; the component logic is already covered by Task 3's tests.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-desktop/src/ExtensionGallery.tsx packages/fez-desktop/src/App.css
git commit -m "gallery: install a prompt pack straight from a GitHub URL"
```

---

### Task 5: Guide persona learns to offer git installs

**Files:**
- Modify: `src/identity/fez-persona.ts` (the "Offering an extension install" section, lines 49-64)
- Test: `packages/fez-evals/tests/fez-persona-git-install.test.ts`

**Interfaces:**
- Consumes: nothing new; Produces: persona text only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { CAPABLE_FEZ_PERSONA } from "../../../src/identity/fez-persona";

// The DM git-install offer only works if the persona keeps teaching it —
// same guard style as the catalog list below it.
describe("guide persona: git install offers", () => {
  it("teaches the git marker form, DM-only", () => {
    expect(CAPABLE_FEZ_PERSONA).toContain("fez:install git:");
    expect(CAPABLE_FEZ_PERSONA).toMatch(/direct message|DM/);
  });
});
```

(Match the import path style of an existing fez-evals test that imports from `src/` — check `packages/fez-evals/tests/cold-start-bootstrap.test.ts` for the alias/relative convention and copy it.)

- [ ] **Step 2: Run to verify it fails** — `npx vitest --run packages/fez-evals/tests/fez-persona-git-install.test.ts`

- [ ] **Step 3: Add the persona paragraph** — append to the "Offering an extension install" section, after the `@fezchat/*` list:

```markdown
**Installing from a GitHub URL (DMs only).** When someone DMs you a link to a
prompt-style agent plugin (markdown skills — e.g. a Claude or Cursor plugin
repo) and asks to install it, first check whether an official \`@fezchat/*\`
extension or a marketplace skill already covers it and offer that instead.
Otherwise offer the repo itself with a line on its own, exactly:

    fez:install git:github.com/owner/repo

Their desktop fetches the repo, shows exactly what's inside, and refuses
anything containing executable code — only they can approve it. This works
only in a direct message with you; in a channel, tell them to DM you.
```

- [ ] **Step 4: Run to verify it passes**, then the persona-adjacent suites: `npx vitest --run packages/fez-evals/tests/fez-persona-git-install.test.ts` and `npx vitest --run packages/fez-evals/tests` (the full evals dir is large; if it's too slow, run at least every test whose name mentions persona, bootstrap, or cold-start).

- [ ] **Step 5: Commit**

```bash
git add src/identity/fez-persona.ts packages/fez-evals/tests/fez-persona-git-install.test.ts
git commit -m "guide: offer prompt-pack installs from GitHub URLs, DM-only"
```

---

### Task 6: See it in the running app

- [ ] **Step 1:** `npm run tauri dev` (from `packages/fez-desktop`) — the standing rule: a harness screenshot is not the user seeing it; start the dev app first.
- [ ] **Step 2:** In the running app: DM @fez "install this https://github.com/anthropics/skills" (any real public prompt-skill repo works; ponytail's real repo is fine too) → confirm the card appears, the consent panel lists personas, install lands files in `~/.fez/personas/`, and the personas show in the app.
- [ ] **Step 3:** Paste the same URL in ⊞ extensions → the URL box; confirm inspect/refuse behavior with a code-bearing repo (e.g. `github.com/KennethAshley/fez` itself must refuse).
- [ ] **Step 4:** Reinstall the same pack; confirm existing persona files were kept (edit one first, reinstall, the edit survives).
- [ ] **Step 5:** No commit — this is the manual gate. Report findings; any desktop release carrying this still goes through `e2e-cold-start.sh` on the mini.
