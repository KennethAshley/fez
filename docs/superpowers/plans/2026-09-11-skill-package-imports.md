# Skill package imports

**Approved direction:** recognize compatible package manifests first; preserve portable skill folders; explicitly identify unsupported foreign plugin integrations. Reuse Fez's existing installer, review card, package inventory, and per-agent assignment.

## Scope and contracts

- GitHub repository, directory, and exact `SKILL.md` URLs retain repository/ref/path through inspection and commit-pinned installation. Invalid or ambiguous paths must fail without widening scope.
- Native Fez manifests produce a full-package report with declared components and permissions. Existing install validation still applies; GitHub source imports never build code or run install hooks.
- Foreign plugin manifests identify integrations Fez cannot load. The review explicitly offers selected portable skills/personas, never presents that as a full plugin install.
- Each selected skill retains its original `SKILL.md`, metadata, and contained support files. No archive traversal, links escaping the package, or execution at import. Existing flat Fez skills remain readable.
- `inspect_git_package` adds `kind`, candidate `path`, `unsupported`, `permissions`, and `components`. `install_git_package` accepts `selectedPaths` and `allowSkillsOnly`; the backend validates both against the inspected commit.
- Runtime discovery supports standard folders, exposes their base directory on loading, and honors manual-only invocation. Installing remains separate from agent assignment.

## Implementation checklist

- [x] Preserve source scope, inspect manifests, validate selections, and convert GitHub archives in the native installer.
- [x] Materialize and discover complete skill folders in native and CLI package paths, preserving legacy flat skills.
- [x] Preserve metadata and relative resources through Fez's agent skill loader, including manual-only skills.
- [x] Route GitHub sources consistently from Tools, Extensions, and chat; review package components or selected skills before installing.
- [x] Verify using local archive fixtures, regression tests, and mocked desktop flows; update user-facing skill documentation.

## Verification

Use fixtures matching a standalone ADHD skill, a multi-skill Ponytail plugin with foreign hooks, and a native Fez package. Cover exact URLs, refs, invalid selections, original file bytes, support resources, package compatibility, permissions, and path/link rejection. Run core/desktop typechecks, focused Rust and GUI tests, desktop build, and the complete Fez eval gate. No paid runs, real third-party installation, release, or reward changes are part of this implementation.

## Completed verification

- Core and all 46 packages build; core typecheck, native Tauri check, and scoped TypeScript lint pass.
- Full Fez gate: 219 test files pass, 2 skipped; 1,978 tests pass, 4 skipped. Final path-validation checks also pass in the 13 focused parser/install tests.
- Native installer/importer: 43 tests pass; the 12 importer tests also pass inside the actual Tauri crate.
- GUI: 11 review-card tests pass; built desktop Tools smoke passes with a mocked bridge/relay, including selected paths, pinned commit, themes, and narrow layout.
- Existing docs.fez.chat skill/tools/extensions pages updated; all three MDX files compile.
- Read-only checks of the user's public examples: ADHD at `6f1f982d0a47c65899af3c5a7450b7098bc65325` supplies one skill plus two support files; Ponytail at `356918eba965ee1eac64bd3a7f0dd02108350de5` supplies six skills. All nine selected files are byte-identical after conversion; TS/Rust metadata agrees.

Ponytail's host hooks, executable adapters, persistent host modes, and argument-hint-based picker are not implemented by a portable import. Its original instructions are preserved and the review lists detected unsupported integrations. No third-party package was installed into the user's app, and no release, paid model run, deployment, or live reward change was performed.
