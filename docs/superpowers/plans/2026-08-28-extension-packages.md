# Extension Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One package directory per installed extension as the source of truth; flat directories become a symlink load index; bins get ownership; `extension_may_spawn` reads the manifest; existing installs migrate.

**Architecture:** Both installers (CLI `PackageManager`, desktop Rust `install_package`) write the same layout: `~/.fez/packages/<base>/` holding `package.json` + part files + `bin/`, with symlinks from the existing flat directories (`gui-extensions/`, `extensions/`, `relay-extensions/`, `workspace-providers/`, `bin/`) into it. Loaders don't change — the flat dirs remain what they read. Authorization (`extension_may_spawn`) reads the package's own `package.json`, not settings. A migration synthesizes package dirs for pre-existing installs from what settings recorded, marked `reconstructed`.

**Tech Stack:** TypeScript (CLI, vitest via fez-evals), Rust (desktop, cargo tests), symlinks with copy fallback.

**Spec:** `docs/superpowers/specs/2026-08-27-extension-packages-design.md` (approved). Companion context: `docs/superpowers/specs/2026-08-28-extension-format-dx.md` (later phases build on this layout — get it right).

## Global Constraints

- Package dir path: `~/.fez/packages/<base>/` where `<base>` is the de-scoped basename (`@fezchat/kanban` → `kanban`) — the same normalization every flat dir already uses (spec open question 2, resolved).
- Load index entries and `~/.fez/bin` entries are SYMLINKS into the package dir; on symlink failure, fall back to a copy (spec open question 1). Ownership test everywhere: "is a symlink AND resolves into `packages/<name>/`". A regular file is legacy (pre-migration) and owned by nobody.
- `settings.json` keeps ONLY user decisions + live config: `extensionPermissions` (granted subset), `backgroundExtensions`, `mcpServers`. `extensionBins` and `extensionVersions` are no longer written and are removed by migration. Versions are read from `packages/<base>/package.json`.
- Grants gate the API, not the files (spec open question 3): a package dir with ungranted parts is untouched.
- `remove` keeps the `mcpServers` entry (existing deliberate behavior — users may have filled env values).
- One bundled file per surface stays; the package dir is never a license to resolve modules (spec non-goal).
- All fez-evals tests run with `bunx vitest run <file>`; Rust tests with `cargo test` in `packages/fez-desktop/src-tauri`.
- Commits: repo voice (lowercase, the why), no co-author trailers.

---

### Task 1: CLI installs into a package directory with a symlink index

**Files:**
- Modify: `src/extensions/package-manager.ts` (`installParts` ~line 698, `installBins` ~line 681, `install` ~line 488)
- Test: `packages/fez-evals/tests/package-lifecycle.test.ts`

**Interfaces:**
- Produces: `~/.fez/packages/<base>/package.json` (the manifest as installed), `~/.fez/packages/<base>/dist/<part>.js`, `~/.fez/packages/<base>/bin/<cmd>`; flat entries `~/.fez/{gui-extensions,extensions,relay-extensions,workspace-providers}/<base>.js` and `~/.fez/bin/<cmd>` become symlinks into the package dir. Helper `packageDir(base: string): string` on PackageManager.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** — add to the existing lifecycle describe, after the "install places every declared part" test:

```ts
test("install keeps the package: one dir with the manifest and the real files", () => {
  const pkgRoot = at("packages", "tidy");
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
  expect(manifest.name).toBe("@fezchat/tidy");
  expect(manifest.version).toBe("0.0.1");
  // the real artifacts live IN the package dir
  for (const rel of ["dist/headless.js", "dist/gui.js", "dist/relay.js", "dist/ws.js", "bin/tidy-tool"]) {
    expect(fs.existsSync(path.join(pkgRoot, rel)), rel).toBe(true);
  }
});

test("the flat directories are an index pointing INTO the package dir", () => {
  for (const [dir, file] of [
    ["extensions", "tidy.js"], ["gui-extensions", "tidy.js"],
    ["relay-extensions", "tidy.js"], ["workspace-providers", "tidy.js"],
    ["bin", "tidy-tool"],
  ] as const) {
    const p = at(dir, file);
    const st = fs.lstatSync(p);
    expect(st.isSymbolicLink(), `${dir}/${file} must be a symlink`).toBe(true);
    expect(fs.realpathSync(p).includes(path.join("packages", "tidy")), `${dir}/${file} must resolve into packages/tidy`).toBe(true);
  }
});
```

- [ ] **Step 2: Run to verify both fail** — `bunx vitest run packages/fez-evals/tests/package-lifecycle.test.ts`. Expected: FAIL — no `packages/tidy` dir; flat entries are regular files.

- [ ] **Step 3: Implement.** In `PackageManager`: add `packageDir(base)` = `this.home("packages", base)`. In `install`, after the manifest is read and before parts install: write `packages/<base>/package.json` (the manifest verbatim) and copy each declared part file plus each bin file into `packages/<base>/` preserving the manifest's relative paths (`dist/gui.js` stays `dist/gui.js`, npm `bin` rel paths keep theirs; bins ALSO get a canonical `bin/<cmd>` copy if the manifest path isn't already under `bin/`). Change `installParts`/`installBins` to create the flat entry as a symlink to the package-dir file — extract one helper used by both:

```ts
/** The load index: a flat entry pointing into the package dir. Symlink
 *  first; copy when the filesystem refuses — the package dir stays the
 *  record either way. */
private linkIndex(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.rmSync(linkPath, { force: true });
  try {
    fs.symlinkSync(target, linkPath);
  } catch {
    fs.copyFileSync(target, linkPath);
  }
}
```

`installBins` chmods the file in the PACKAGE dir (0o755) — the symlink inherits.

- [ ] **Step 4: Run the whole lifecycle file** — all tests pass, including the pre-existing ones (they use `fs.existsSync`, which follows symlinks, so they keep passing unchanged; the "update refreshes" test now exercises re-linking).

- [ ] **Step 5: Commit** — `git add src/extensions/package-manager.ts packages/fez-evals/tests/package-lifecycle.test.ts && git commit` — message theme: the CLI keeps the package; the flat dirs become an index.

### Task 2: CLI bin ownership — refuse collisions, remove only your own

**Files:**
- Modify: `src/extensions/package-manager.ts` (`installBins`, `remove`/`removeParts` ~line 774)
- Test: `packages/fez-evals/tests/package-lifecycle.test.ts`

**Interfaces:**
- Produces: `binOwner(binPath: string): string | undefined` on PackageManager — the package name a `~/.fez/bin` entry's symlink resolves into, else undefined (regular file or foreign target = unowned).
- Consumes: Task 1's layout (symlinks into `packages/<base>/`).

- [ ] **Step 1: Write the failing tests** — new describe in the same file; build a SECOND fixture package `clash` in `beforeAll`-style setup inside the test (own tmp git repo, `bin: { "tidy-tool": "dist/tool.js" }`, no parts):

```ts
describe("bin ownership — the flat namespace stops colliding silently", () => {
  test("a second package shipping the same command is refused, naming the owner", async () => {
    const clashDir = path.join(tmp, "clash");
    fs.mkdirSync(path.join(clashDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(clashDir, "package.json"), JSON.stringify({
      name: "@fezchat/clash", version: "0.0.1", private: true, type: "module",
      bin: { "tidy-tool": "dist/tool.js" }, fez: { type: "extension" },
    }));
    fs.writeFileSync(path.join(clashDir, "dist", "tool.js"), "export default 1;\n");
    git(clashDir, "init -q"); git(clashDir, "add -A"); git(clashDir, "commit -q -m v1");

    await pm.install(`git:${pkgDir}`); // tidy owns tidy-tool again
    await expect(pm.install(`git:${clashDir}`)).rejects.toThrow(/tidy-tool.*tidy/);
    // the loser must not have half-installed the bin
    expect(fs.realpathSync(at("bin", "tidy-tool")).includes(path.join("packages", "tidy"))).toBe(true);
  });

  test("removing one package never deletes a bin another still owns", async () => {
    // simulate a foreign owner: hand-plant a symlink into a different package dir
    const foreign = at("packages", "other", "bin");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "shared-cmd"), "x");
    fs.symlinkSync(path.join(foreign, "shared-cmd"), at("bin", "shared-cmd"));

    await pm.remove("tidy");
    expect(fs.existsSync(at("bin", "tidy-tool"))).toBe(false);       // its own: gone
    expect(fs.existsSync(at("bin", "shared-cmd"))).toBe(true);       // the other's: untouched
  });
});
```

- [ ] **Step 2: Run — verify failures** (second install currently overwrites silently; remove currently deletes by name).
- [ ] **Step 3: Implement.** `binOwner(p)`: `lstat` — if not a symlink return undefined; `realpath` — if it matches `home/packages/<name>/…` return `<name>`. `installBins`: before linking, if the destination exists and `binOwner` names a DIFFERENT package, throw `` `bin "${cmd}" is already installed by ${owner} — refusing` `` (and abort the whole install before any settings write). `remove`: for each bin the package dir's manifest declares, delete the flat entry only when `binOwner` returns this package.
- [ ] **Step 4: Run the file** — green, including the earlier tasks' tests.
- [ ] **Step 5: Commit.**

### Task 3: CLI remove/update read the package dir, not guesses

**Files:**
- Modify: `src/extensions/package-manager.ts` (`remove`, `update`, `get`)
- Test: `packages/fez-evals/tests/package-lifecycle.test.ts`

**Interfaces:**
- Produces: `installedManifest(base: string): FezManifest & {name: string; version: string} | undefined` — reads `packages/<base>/package.json`.
- Consumes: Tasks 1-2.

- [ ] **Step 1: Failing test:**

```ts
test("remove is driven by the package dir and deletes it last", async () => {
  await pm.install(`git:${pkgDir}`);
  await pm.remove("tidy");
  expect(fs.existsSync(at("packages", "tidy"))).toBe(false);
  // and every index entry that resolved into it is gone
  for (const [dir, f] of [["extensions","tidy.js"],["gui-extensions","tidy.js"],["relay-extensions","tidy.js"],["workspace-providers","tidy.js"],["bin","tidy-tool"]] as const) {
    expect(fs.existsSync(at(dir, f)), `${dir}/${f}`).toBe(false);
  }
});

test("version comes from the package dir, not from settings", async () => {
  await pm.install(`git:${pkgDir}`);
  expect(pm.installedManifest("tidy")?.version).toBe("0.0.1");
  const s = settings.load() as Record<string, unknown>;
  expect(s.extensionVersions).toBeUndefined();
  expect(s.extensionBins).toBeUndefined();
});
```

- [ ] **Step 2: Run — verify failure.**
- [ ] **Step 3: Implement.** `remove(base)`: read `installedManifest`; from its `fez.parts` + `bin` map compute exactly which index entries to check, delete those owned (symlink-resolves-into rule), then `rm -rf packages/<base>`, then the settings cleanup it already does (permissions, backgroundExtensions; keep mcpServers). If there is no package dir, fall back to the current name-candidate sweep once (legacy, until migration has run) — leave the existing code as the fallback branch with a comment naming Task 7. Ensure `install`/`update` never write `extensionVersions`/`extensionBins` (grep and delete those writes if the CLI has them; the desktop's are Task 5).
- [ ] **Step 4: Run file — green.**
- [ ] **Step 5: Commit.**

### Task 4: Rust — extract the testable installer core

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (`install_package` line ~886)
- Create: `packages/fez-desktop/src-tauri/src/package_install.rs`
- Test: cargo tests inside `package_install.rs`

**Interfaces:**
- Produces: `pub(crate) fn install_from_tarball(name: &str, tar_bytes: &[u8], version: &str, home: &Path) -> Result<InstallOutcome, String>` where `InstallOutcome { pub installed: Vec<String>, pub skill_entry: Option<serde_json::Value>, pub perms: Vec<String>, pub wants_background: bool, pub base: String }`. The Tauri `install_package` becomes: fetch (steps 1-3b unchanged) → `install_from_tarball` → the existing `update_settings` block fed from `InstallOutcome`.
- Consumes: existing `tar_read`, `tar_list_md`, `min_fez_version_error` (move them into the new module or `pub(crate)` them).

- [ ] **Step 1: Write the failing cargo test.** In `package_install.rs`, a helper that builds a real npm-shaped tarball in memory (tar format: 512-byte headers; simplest is the `tar` crate — add `tar = "0.4"` as a dependency if absent; `flate2` is already there; entries prefixed `package/`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_tar() -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        let add = |b: &mut tar::Builder<Vec<u8>>, path: &str, data: &str| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64); h.set_mode(0o644); h.set_cksum();
            b.append_data(&mut h, path, data.as_bytes()).unwrap();
        };
        add(&mut b, "package/package.json", r#"{
          "name": "@fezchat/tidy", "version": "0.0.1",
          "bin": {"tidy-tool": "dist/tool.js"},
          "fez": {"type": "extension", "permissions": ["ui"],
                  "parts": {"gui": "dist/gui.js", "headless": "dist/headless.js"}}
        }"#);
        add(&mut b, "package/dist/gui.js", "export default 1;\n");
        add(&mut b, "package/dist/headless.js", "export default 2;\n");
        add(&mut b, "package/dist/tool.js", "#!/usr/bin/env node\n");
        b.into_inner().unwrap()
    }

    #[test]
    fn installs_into_a_package_dir_with_a_symlink_index() {
        let home = tempfile::tempdir().unwrap(); // add tempfile dev-dep if absent
        let out = install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        assert_eq!(out.base, "tidy");
        let pkg = home.path().join("packages").join("tidy");
        assert!(pkg.join("package.json").exists());
        assert!(pkg.join("dist/gui.js").exists());
        assert!(pkg.join("bin/tidy-tool").exists());
        for (dir, f) in [("gui-extensions","tidy.js"), ("extensions","tidy.js"), ("bin","tidy-tool")] {
            let p = home.path().join(dir).join(f);
            let md = std::fs::symlink_metadata(&p).unwrap();
            assert!(md.file_type().is_symlink(), "{dir}/{f} must be a symlink");
            assert!(std::fs::canonicalize(&p).unwrap().starts_with(&std::fs::canonicalize(&pkg).unwrap()));
        }
    }
}
```

- [ ] **Step 2: `cargo test installs_into` — fails to compile** (module/function missing).
- [ ] **Step 3: Implement.** Move steps 4-5c and 7 of today's `install_package` into `install_from_tarball` in the new module, changed to: write every referenced tarball file under `packages/<base>/` first (manifest, parts at their manifest-relative paths, bins under both their rel path and canonical `bin/<cmd>`, skill `.js` files under their rel path — the skill entry's absolutized args now point INTO the package dir, replacing the `skills/<base>/` copy), then create the flat index entries as symlinks (copy fallback), same `linkIndex` semantics as the CLI. `install_package` keeps fetch + version resolution + `min_fez_version_error` gate + the `update_settings` block (minus the two keys Task 5 deletes).
- [ ] **Step 4: `cargo test` — green, no warnings.**
- [ ] **Step 5: Commit.**

### Task 5: Rust — remove reads the manifest; settings drop the cached claims

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (`remove_extension` ~line 1257, `install_package` settings block ~1077-1103, `read_extension_versions` ~1147)
- Modify: `packages/fez-desktop/src-tauri/src/package_install.rs` (add `remove_installed` + `installed_version`)
- Test: cargo tests in `package_install.rs`

**Interfaces:**
- Produces: `pub(crate) fn remove_installed(base: &str, home: &Path) -> Result<Vec<String>, String>` (deletes owned index entries per the manifest, then the package dir; returns what it removed; `Err` when no package dir — caller falls back to the legacy sweep). `pub(crate) fn installed_version(base: &str, home: &Path) -> Option<String>`.
- Consumes: Task 4's layout.

- [ ] **Step 1: Failing cargo tests:**

```rust
#[test]
fn remove_deletes_the_dir_and_only_its_own_index_entries() {
    let home = tempfile::tempdir().unwrap();
    install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
    // a foreign symlink sharing the bin dir must survive
    let other = home.path().join("packages").join("other").join("bin");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("keep-me"), "x").unwrap();
    std::os::unix::fs::symlink(other.join("keep-me"), home.path().join("bin").join("keep-me")).unwrap();

    remove_installed("tidy", home.path()).unwrap();
    assert!(!home.path().join("packages").join("tidy").exists());
    assert!(!home.path().join("gui-extensions").join("tidy.js").exists());
    assert!(!home.path().join("bin").join("tidy-tool").exists());
    assert!(home.path().join("bin").join("keep-me").exists());
}

#[test]
fn version_reads_from_the_package_dir() {
    let home = tempfile::tempdir().unwrap();
    install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
    assert_eq!(installed_version("tidy", home.path()).as_deref(), Some("0.0.1"));
}
```

- [ ] **Step 2: Run — compile failure (functions missing).**
- [ ] **Step 3: Implement.** `remove_installed` mirrors Task 3's CLI logic. Rewire `remove_extension`: try `remove_installed` first; on `Err` fall back to today's candidate sweep (comment: legacy installs until migration, Task 7). Delete the `extensionVersions`/`extensionBins` writes from `install_package`'s settings block; keep their REMOVAL lines in `remove_extension` (they clean legacy state). Repoint `read_extension_versions` at `installed_version` over the `packages/` dir listing, with the settings key as fallback for not-yet-migrated installs.
- [ ] **Step 4: `cargo test` — green.**
- [ ] **Step 5: Commit.**

### Task 6: `extension_may_spawn` reads the package manifest

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (`extension_may_spawn` ~line 2137, its caller `spawn_extension_agent`)
- Test: `packages/fez-desktop/src-tauri/src/managed_agents.rs` (existing tests ~lines 51-77)

**Interfaces:**
- Produces: new signature `fn extension_may_spawn(settings: &serde_json::Value, manifest: Option<&serde_json::Value>, extension: &str, bin: &str) -> Result<(), String>` — `processes` grant still from settings; the bin claim now from the manifest's npm `bin` map. Caller loads the manifest via `installed_manifest(base, home) -> Option<Value>` (add to `package_install.rs`).
- Consumes: Task 4-5 layout.

- [ ] **Step 1: Update the four existing `extension_may_spawn` tests in `managed_agents.rs`** to pass a manifest instead of relying on `extensionBins` — e.g.:

```rust
fn manifest_with_bin(bins: &[&str]) -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> =
        bins.iter().map(|b| ((*b).to_string(), serde_json::json!(format!("dist/{b}.js")))).collect();
    serde_json::json!({ "name": "x", "bin": map })
}
// an_extension_may_start_a_bin_it_shipped:
assert!(crate::extension_may_spawn(&settings(), Some(&manifest_with_bin(&["fez-bazaar-miner"])), "bazaar", "fez-bazaar-miner").is_ok());
// a_bin_nobody_installed_is_unreachable_under_any_name gains:
assert!(crate::extension_may_spawn(&settings(), None, "bazaar", "fez-bazaar-miner").is_err(), "no package dir, no spawn");
// and a reconstructed-manifest case (Task 7's marker changes nothing here — the claim is the bin map):
```

Also remove `extensionBins` from the `settings()` fixture so the tests PROVE settings no longer participates in the bin claim.

- [ ] **Step 2: `cargo test` — compile failure / assertion failures.**
- [ ] **Step 3: Implement** the new signature; `spawn_extension_agent` loads `installed_manifest(&extension, &home)` and passes it. The permission check is unchanged (settings = the user's grant); only the "did this package ship this bin" half moves to the manifest.
- [ ] **Step 4: `cargo test` — green.**
- [ ] **Step 5: Commit.**

### Task 7: Migration — existing installs get a package dir

**Files:**
- Create: `packages/fez-desktop/src-tauri/src/package_migrate.rs`
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs` (call at startup, where `ensure_local_relay`/bundle-copy boot work already runs)
- Test: cargo tests in `package_migrate.rs`

**Interfaces:**
- Produces: `pub(crate) fn migrate_flat_installs(home: &Path, settings: &serde_json::Value) -> Result<Vec<String>, String>` — idempotent; returns a log of what it moved. Reconstructed manifests carry `"fez": { …, "reconstructed": true }`.
- Consumes: `extensionPermissions` (names), `extensionBins` (bin claims), `extensionVersions` (versions) from settings; the flat files on disk.

- [ ] **Step 1: Failing cargo test** — build a fake OLD home in a tempdir and assert the new shape:

```rust
#[test]
fn a_flat_install_becomes_a_reconstructed_package() {
    let home = tempfile::tempdir().unwrap();
    for d in ["gui-extensions", "bin"] { std::fs::create_dir_all(home.path().join(d)).unwrap(); }
    std::fs::write(home.path().join("gui-extensions").join("fez-bazaar.js"), "gui").unwrap();
    std::fs::write(home.path().join("bin").join("fez-bazaar-miner"), "bin").unwrap();
    let settings = serde_json::json!({
        "extensionPermissions": { "fez-bazaar": ["ui", "processes"] },
        "extensionBins": { "fez-bazaar": ["fez-bazaar-miner"] },
        "extensionVersions": { "fez-bazaar": "0.1.0" },
    });
    migrate_flat_installs(home.path(), &settings).unwrap();

    let pkg = home.path().join("packages").join("fez-bazaar");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(pkg.join("package.json")).unwrap()).unwrap();
    assert_eq!(manifest.pointer("/fez/reconstructed"), Some(&serde_json::json!(true)));
    assert_eq!(manifest.pointer("/version"), Some(&serde_json::json!("0.1.0")));
    assert_eq!(manifest.pointer("/bin/fez-bazaar-miner"), Some(&serde_json::json!("bin/fez-bazaar-miner")));
    // files moved in; flat entries are now symlinks into the package dir
    assert!(pkg.join("dist/gui.js").exists());
    assert!(pkg.join("bin/fez-bazaar-miner").exists());
    let link = home.path().join("gui-extensions").join("fez-bazaar.js");
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    // running twice changes nothing (idempotent)
    migrate_flat_installs(home.path(), &settings).unwrap();
}
```

- [ ] **Step 2: Run — compile failure.**
- [ ] **Step 3: Implement.** For each name in `extensionPermissions` with no `packages/<name>/`: synthesize `package.json` — `name`, `version` from `extensionVersions` (else `"0.0.0"`), `bin` map from `extensionBins` (each `cmd` → `bin/<cmd>`), `fez.parts` from which flat files exist for the name (gui/headless/relay/workspace → `dist/<part>.js`), `fez.permissions` = the granted list (visible claim = what was granted; reconstructed manifests must not claim more), `fez.reconstructed: true`. MOVE each flat file into the package dir and symlink back; move bins likewise. Skip a name whose flat files are all absent (a settings orphan) but report it. Then the CALLER (startup hook in lib.rs) deletes `extensionBins` + `extensionVersions` from settings once migration returns Ok — settings mutation stays out of the testable core. Wire the startup call next to the existing boot work, logging each line.
- [ ] **Step 4: `cargo test` — green.**
- [ ] **Step 5: Commit.**

### Task 8: The lifecycle contract, asserted on both sides

**Files:**
- Modify: `packages/fez-evals/tests/package-lifecycle.test.ts` (golden layout list + cross-reference comment)
- Modify: `packages/fez-desktop/src-tauri/src/package_install.rs` (same golden list in the cargo test, cross-reference comment)

**Interfaces:** none new — this task pins the CLI and Rust installers to one written contract.

- [ ] **Step 1: In BOTH test files, add the same golden layout block with a comment pointing at the other file:**

```
// THE LAYOUT CONTRACT — must match <other test file path> exactly.
// packages/<base>/package.json        the manifest, as installed
// packages/<base>/dist/<part>.js      real part files
// packages/<base>/bin/<cmd>           real binaries (0755)
// <flat dir>/<base>.js  -> symlink into packages/<base>/
// bin/<cmd>             -> symlink into packages/<base>/
```

vitest side: a test iterating the list against the tidy fixture. cargo side: extend `installs_into_a_package_dir_with_a_symlink_index` to cover every line.

- [ ] **Step 2: Run both suites — green** (this task should only ADD assertions; a failure here is a real divergence found — fix the divergent installer, not the test).
- [ ] **Step 3: Commit.**

### Task 9: Migrate the real machine, verify in the running app

**Files:** none (operational verification — the spec's "Done when" on live state).

- [ ] **Step 1: Snapshot** `~/.fez/settings.json` and `ls -R` of the five flat dirs to the session scratchpad (rollback reference).
- [ ] **Step 2: Rebuild the desktop app** (`./scripts/build-signed.sh`, swap `/Applications/fez.app`, relaunch — the established flow) so the migration runs at boot.
- [ ] **Step 3: Verify on disk:** `~/.fez/packages/<name>/` exists for every previously installed extension (fez-bazaar at minimum); its manifest says `reconstructed: true`; flat entries are symlinks; `extensionBins`/`extensionVersions` gone from settings; `extensionPermissions` intact.
- [ ] **Step 4: Verify behavior:** the Bazaar panel renders; send/recall still passes `extension_may_spawn` (now manifest-backed); agents still spawn; the gallery still shows versions.
- [ ] **Step 5: Commit nothing — report.** Any failure here reverts the app swap (previous fez.app) and files the fix as a follow-up task.

## Self-review

- Spec coverage: package dir as source of truth (T1/T4), load index (T1/T4), bin namespacing + ownership (T2/T5), one implementation two callers → one CONTRACT two implementations, asserted (T8), `extension_may_spawn` off settings (T6), `extensionBins`/`extensionVersions` deleted (T3/T5/T7), migration with reconstructed marker and no-new-grants rule (T7 — permissions in reconstructed manifests are capped at the granted list), uninstall completeness (T3/T5), real-machine flip (T9, Ken's explicit requirement).
- Legacy fallbacks are explicit and temporary: remove's candidate sweep and version's settings fallback both carry comments naming Task 7 as their retirement condition.
- Open questions resolved per Global Constraints; non-goals untouched (no API changes, no load-path changes, no dependency trees).
