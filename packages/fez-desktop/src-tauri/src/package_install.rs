//! The testable core of extension install: given an already-fetched npm
//! tarball, place its parts under `~/.fez/packages/<base>/` and index them
//! into the flat dirs (`gui-extensions/`, `extensions/`, `bin/`, ...) as
//! symlinks — same layout the CLI's `PackageManager` produces
//! (`src/extensions/package-manager.ts`). Callers own the fetch (registry
//! lookup, download, gunzip, the minFezVersion gate) and the settings.json
//! write; this module only ever touches the filesystem under `home`.

use std::path::{Path, PathBuf};

/// Read one file out of an in-memory npm tarball. Entries are prefixed
/// with "package/"; `rel` is the path within the package ("package.json",
/// "dist/gui.js").
pub(crate) fn tar_read(tar_bytes: &[u8], rel: &str) -> Option<Vec<u8>> {
    let mut archive = tar::Archive::new(tar_bytes);
    for entry in archive.entries().ok()? {
        let mut entry = entry.ok()?;
        let path = entry.path().ok()?.into_owned();
        if path.strip_prefix("package").ok() == Some(std::path::Path::new(rel)) {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).ok()?;
            return Some(buf);
        }
    }
    None
}

/// List `<dir>/*.md` files in an npm tarball (which prefixes paths with
/// "package/"), as (id, content) where id is the lowercased basename —
/// for persona packs.
pub(crate) fn tar_list_md(tar_bytes: &[u8], dir: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut archive = tar::Archive::new(tar_bytes);
    let entries = match archive.entries() {
        Ok(e) => e,
        Err(_) => return out,
    };
    let prefix = format!("{dir}/");
    for entry in entries {
        let mut entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let rel = match entry
            .path()
            .ok()
            .and_then(|p| p.strip_prefix("package").ok().map(|r| r.to_path_buf()))
        {
            Some(r) => r,
            None => continue,
        };
        let rel_str = rel.to_string_lossy().to_string();
        let name = match rel.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if rel_str.starts_with(&prefix) && name.ends_with(".md") {
            let mut buf = String::new();
            if std::io::Read::read_to_string(&mut entry, &mut buf).is_ok() {
                out.push((name.trim_end_matches(".md").to_lowercase(), buf));
            }
        }
    }
    out
}

/// Everything an install produced, for the caller (the Tauri command) to
/// fold into settings.json. This module never writes settings itself.
#[derive(Debug)]
pub(crate) struct InstallOutcome {
    /// Human-readable "what happened" lines, also mined by the caller for
    /// bin command names (`"bin → ~/.fez/bin/<cmd>"`).
    pub installed: Vec<String>,
    pub skill_entry: Option<serde_json::Value>,
    pub perms: Vec<String>,
    pub wants_background: bool,
    /// De-scoped package name — the packages/<base> dir and every flat
    /// index file are named from this.
    pub base: String,
}

/// Write `bytes` to `path` so a reader (or the "am I done" existence check
/// both `install_from_tarball` and Task 7's `migrate_flat_installs` use)
/// only ever observes a complete file, never a torn one. A crash mid a
/// plain `std::fs::write` can leave a truncated/invalid file sitting at the
/// target path — and for `package.json` specifically, that file's mere
/// existence IS the completion marker, so a torn one gets treated as done
/// forever, with every reader (`installed_manifest`'s
/// `serde_json::from_slice(..).ok()`) silently seeing `None`. Writing to a
/// same-directory `.tmp` sibling first and `rename`-ing over the target
/// avoids that: POSIX rename is atomic, so the target is either the old
/// file or the new one, never a partial write of either. Same directory
/// keeps the rename on one filesystem (a cross-filesystem rename isn't
/// atomic and can fail outright).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// The load index: a flat entry pointing into the package dir. Symlink
/// first; copy when the filesystem refuses — the package dir stays the
/// record either way (mirrors the CLI's `linkIndex`). `pub(crate)` so
/// Task 7's migration (`package_migrate.rs`) reuses this instead of
/// re-deriving symlink-vs-copy fallback logic.
pub(crate) fn link_index(target: &Path, link_path: &Path) -> Result<(), String> {
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(link_path);
    if std::os::unix::fs::symlink(target, link_path).is_err() {
        std::fs::copy(target, link_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy a manifest-relative file out of the tarball into the package dir at
/// that same relative path (mirrors the CLI's `materializeIntoPackage`) and
/// return the absolute destination — the flat dirs symlink to this. A
/// manifest path must stay inside the package dir: absolute paths and `..`
/// segments are refused rather than guessed at (a hostile manifest gets a
/// clean error, not a write outside `packages/<base>/`).
fn materialize(tar_bytes: &[u8], pkg_dir: &Path, rel: &str, missing_ctx: &str) -> Result<PathBuf, String> {
    if rel.starts_with('/') || Path::new(rel).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{missing_ctx} path {rel} escapes the package — refusing"));
    }
    let bytes = tar_read(tar_bytes, rel).ok_or_else(|| format!("{missing_ctx} {rel} missing from tarball"))?;
    let dest = pkg_dir.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Place an already-fetched, already-gated npm tarball into
/// `~/.fez/packages/<base>/` and index it into the flat dirs. Does NOT
/// touch settings.json — the caller feeds the returned `InstallOutcome`
/// into its own `update_settings` call.
pub(crate) fn install_from_tarball(
    name: &str,
    tar_bytes: &[u8],
    _version: &str,
    home: &Path,
) -> Result<InstallOutcome, String> {
    let pkg_bytes = tar_read(tar_bytes, "package.json").ok_or("no package.json in tarball")?;
    let pkg: serde_json::Value =
        serde_json::from_slice(&pkg_bytes).map_err(|e| format!("bad package.json: {e}"))?;

    // De-scoped basename is the file/extension name: @fezchat/kanban → kanban.
    let base = name.rsplit('/').next().unwrap_or(name).trim_start_matches('@').to_string();
    let parts = pkg.pointer("/fez/parts");
    let pkg_dir = home.join("packages").join(&base);
    std::fs::create_dir_all(&pkg_dir).map_err(|e| e.to_string())?;

    // The manifest as installed, verbatim — the package dir's own record
    // (mirrors the CLI's writePackageManifest). Atomic: package.json's mere
    // existence is what Task 7's migration (and any reader via
    // `installed_manifest`) treats as "this package is fully installed" —
    // a torn write from a mid-write crash must never be observable there.
    write_atomic(&pkg_dir.join("package.json"), &pkg_bytes).map_err(|e| e.to_string())?;

    let mut installed: Vec<String> = Vec::new();

    // Code parts: materialize into the package dir, index with a symlink.
    for (part_key, dir) in [
        ("gui", "gui-extensions"),
        ("headless", "extensions"),
        ("relay", "relay-extensions"),
        ("workspace", "workspace-providers"),
    ] {
        let rel = match parts.and_then(|p| p.get(part_key)).and_then(|v| v.as_str()) {
            Some(r) => r,
            None => continue,
        };
        let dest = materialize(tar_bytes, &pkg_dir, rel, part_key)?;
        let link_path = home.join(dir).join(format!("{base}.js"));
        link_index(&dest, &link_path)?;
        installed.push(format!("{part_key} → ~/.fez/{dir}/{base}.js"));
    }

    // Skill part → an MCP server entry (settings write is the caller's job).
    // A relative .js arg is now materialized INTO the package dir — same as
    // every other part — and absolutized to that path, replacing the old
    // skills/<base>/ copy destination. A bare command (e.g. `npx
    // <public-server>`) or an already-absolute arg passes through.
    let mut skill_entry: Option<serde_json::Value> = None;
    if let Some(skill) = parts.and_then(|p| p.get("skill")) {
        let mut entry = skill.clone();
        if let Some(args) = skill.get("args").and_then(|v| v.as_array()) {
            let mut new_args: Vec<serde_json::Value> = Vec::new();
            for a in args {
                if let Some(s) = a.as_str() {
                    if s.ends_with(".js") && !s.starts_with('/') {
                        if let Ok(dest) = materialize(tar_bytes, &pkg_dir, s, "skill") {
                            new_args.push(serde_json::json!(dest.to_string_lossy()));
                            continue;
                        }
                    }
                }
                new_args.push(a.clone());
            }
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("args".to_string(), serde_json::json!(new_args));
            }
        }
        installed.push(format!("skill → settings.json mcpServers/{base}"));
        skill_entry = Some(entry);
    }

    // npm's own bin map → packages/<base>/<rel>, plus a canonical
    // packages/<base>/bin/<cmd> copy (chmod 0755), indexed at
    // ~/.fez/bin/<cmd> (mirrors the CLI's installBins).
    if let Some(bins) = pkg.get("bin").and_then(|v| v.as_object()) {
        for (cmd, rel) in bins {
            if !safe_bin_name(cmd) {
                continue;
            }
            let rel = match rel.as_str() {
                Some(r) => r,
                None => continue,
            };
            let dest = materialize(tar_bytes, &pkg_dir, rel, "bin")?;
            // Always land a canonical packages/<base>/bin/<cmd> copy — the
            // manifest's own rel path (e.g. "bin/index.js") only happens to
            // match `cmd` when the source file is itself named after the
            // command, which is not the common npm shape. The symlink index
            // always targets this canonical copy, never `dest` directly.
            let canonical = pkg_dir.join("bin").join(cmd);
            if let Some(parent) = canonical.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&dest, &canonical).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&canonical, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            link_index(&canonical, &home.join("bin").join(cmd))?;
            installed.push(format!("bin → ~/.fez/bin/{cmd}"));
        }
    }

    let perms: Vec<String> = pkg
        .pointer("/fez/permissions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let wants_background = parts
        .and_then(|p| p.get("background"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Persona pack — mirror the CLI's installPersonaPack: copy each
    // <dir>/*.md into ~/.fez/personas. No symlink index — these are content
    // read by the sentinel, not code that gets loaded.
    if pkg.pointer("/fez/personas").is_some() {
        let dir = pkg.pointer("/fez/personas/dir").and_then(|v| v.as_str()).unwrap_or("personas");
        let personas_dir = home.join("personas");
        std::fs::create_dir_all(&personas_dir).ok();
        for (id, content) in tar_list_md(tar_bytes, dir) {
            if !content.contains("harness:") {
                continue; // not a valid persona — skip quietly
            }
            let dest = personas_dir.join(format!("{id}.md"));
            if dest.exists() {
                continue; // keep the user's copy
            }
            if std::fs::write(&dest, &content).is_ok() {
                installed.push(format!("persona @{id} → ~/.fez/personas/{id}.md"));
            }
        }
    }

    Ok(InstallOutcome { installed, skill_entry, perms, wants_background, base })
}

/// A bin map KEY is trusted only as far as this: a bare filename, never a
/// path. The map itself comes from a package's `package.json`, stored
/// verbatim at install — an attacker-authored package can declare
/// `"/bin/sh"` or `"../../x"` as a key just as easily as an honest one, and
/// `PathBuf::join` on an absolute component discards the base entirely
/// rather than erroring. Every site that turns a bin key into a real path
/// (installing it, removing it, or — Task 6 — deciding whether an extension
/// may spawn it) must pass the key through this first.
pub(crate) fn safe_bin_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains("..")
}

/// The manifest a package was installed with, read back verbatim from
/// `packages/<base>/package.json` — the package dir's own record, never
/// settings. `None` when there's no package dir: a name nothing installed,
/// an install that predates this layout and hasn't been migrated yet (Task
/// 7), or `base` isn't a shape a package dir was ever named with (the
/// caller may be handing this a webview-supplied string, same guard
/// `remove_extension`/`package_info` apply before touching disk).
pub(crate) fn installed_manifest(base: &str, home: &Path) -> Option<serde_json::Value> {
    if base.is_empty() || base.len() > 128 || !base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return None;
    }
    let content = std::fs::read(home.join("packages").join(base).join("package.json")).ok()?;
    serde_json::from_slice(&content).ok()
}

/// The version a package was installed with, from its own manifest.
pub(crate) fn installed_version(base: &str, home: &Path) -> Option<String> {
    installed_manifest(base, home)?.get("version")?.as_str().map(String::from)
}

/// Delete an index entry iff `base` still owns it — a symlink whose
/// canonicalized target resolves under the canonicalized `packages/<base>/`
/// (mirrors the CLI's `binOwner`/`removeIfOwned`). A regular file (legacy
/// layout, or a copy-fallback), a broken symlink, or one that resolves
/// somewhere else entirely is left alone. Both sides get canonicalized —
/// on macOS `/var` is itself a symlink to `/private/var`, so a
/// tempdir-rooted `home` resolves the entry there while an un-canonicalized
/// `packages` dir still reads `/var/...`, and a prefix check across that
/// mismatch would silently treat every package as unowned.
fn remove_if_owned(entry: &Path, base: &str, packages_dir: &Path) -> bool {
    let is_symlink = std::fs::symlink_metadata(entry).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if !is_symlink {
        return false;
    }
    let (Ok(real), Ok(real_packages)) = (std::fs::canonicalize(entry), std::fs::canonicalize(packages_dir)) else {
        return false;
    };
    let owner = real.strip_prefix(&real_packages).ok().and_then(|rest| rest.components().next());
    if owner.map(|c| c.as_os_str() == base) != Some(true) {
        return false;
    }
    std::fs::remove_file(entry).is_ok()
}

/// The modern side of remove: read `packages/<base>/package.json` back for
/// the exact index entries THIS install named — never guessed from `base`
/// alone — delete each only if `base` still owns it, then drop the package
/// dir itself last (index entries must go first: they're symlinks INTO the
/// package dir, so dropping it first would leave them broken and
/// unremovable-as-owned). `Err` when there's no package dir — the caller
/// falls back to the legacy name-guess sweep.
pub(crate) fn remove_installed(base: &str, home: &Path) -> Result<Vec<String>, String> {
    let manifest = installed_manifest(base, home).ok_or("no package dir")?;
    let packages_dir = home.join("packages");
    let mut removed = Vec::new();

    let parts = manifest.pointer("/fez/parts");
    for (part_key, dir) in [
        ("gui", "gui-extensions"),
        ("headless", "extensions"),
        ("relay", "relay-extensions"),
        ("workspace", "workspace-providers"),
    ] {
        if parts.and_then(|p| p.get(part_key)).is_none() {
            continue;
        }
        let entry = home.join(dir).join(format!("{base}.js"));
        if remove_if_owned(&entry, base, &packages_dir) {
            removed.push(format!("{dir}/{base}.js"));
        }
    }
    if let Some(bins) = manifest.get("bin").and_then(|v| v.as_object()) {
        for cmd in bins.keys() {
            let entry = home.join("bin").join(cmd);
            if remove_if_owned(&entry, base, &packages_dir) {
                removed.push(format!("bin/{cmd}"));
            }
        }
    }

    std::fs::remove_dir_all(packages_dir.join(base)).map_err(|e| e.to_string())?;
    removed.push(format!("packages/{base}"));
    Ok(removed)
}

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
          "bin": {"tidy-tool": "dist/tool.js", "clix": "bin/index.js"},
          "fez": {"type": "extension", "permissions": ["ui"],
                  "parts": {"gui": "dist/gui.js", "headless": "dist/headless.js",
                            "skill": {"command": "node", "args": ["dist/mcp.js"]}}}
        }"#);
        add(&mut b, "package/dist/gui.js", "export default 1;\n");
        add(&mut b, "package/dist/headless.js", "export default 2;\n");
        add(&mut b, "package/dist/tool.js", "#!/usr/bin/env node\n");
        add(&mut b, "package/bin/index.js", "#!/usr/bin/env node\n");
        add(&mut b, "package/dist/mcp.js", "export default 3;\n");
        b.into_inner().unwrap()
    }

    #[test]
    fn installs_into_a_package_dir_with_a_symlink_index() {
        let home = tempfile::tempdir().unwrap(); // add tempfile dev-dep if absent
        let out = install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        assert_eq!(out.base, "tidy");
        let pkg = home.path().join("packages").join("tidy");
        let pkg_real = std::fs::canonicalize(&pkg).unwrap();
        assert!(pkg.join("package.json").exists());
        assert!(pkg.join("dist/gui.js").exists());
        assert!(pkg.join("bin/tidy-tool").exists());
        for (dir, f) in [("gui-extensions","tidy.js"), ("extensions","tidy.js"), ("bin","tidy-tool"), ("bin","clix")] {
            let p = home.path().join(dir).join(f);
            let md = std::fs::symlink_metadata(&p).unwrap();
            assert!(md.file_type().is_symlink(), "{dir}/{f} must be a symlink");
            assert!(std::fs::canonicalize(&p).unwrap().starts_with(&pkg_real));
        }

        // A bin entry shaped "clix": "bin/index.js" — a source file that
        // does NOT already sit at bin/<cmd> — must still land a canonical
        // packages/<base>/bin/clix copy, chmod 0755.
        let clix = pkg.join("bin/clix");
        assert!(clix.exists());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&clix).unwrap().permissions().mode() & 0o777, 0o755);

        // Skill relocation: the .js arg is materialized into the package
        // dir and absolutized there, replacing the old ~/.fez/skills/<base>/
        // copy destination outright.
        let skill = out.skill_entry.expect("skill part should produce an entry");
        let arg0 = skill["args"][0].as_str().unwrap();
        assert!(Path::new(arg0).is_absolute());
        assert!(std::fs::canonicalize(arg0).unwrap().starts_with(&pkg_real), "skill arg must resolve into the package dir");
        assert!(Path::new(arg0).exists());
        assert!(!home.path().join("skills").exists(), "skills/ must not be written anymore");
    }

    #[test]
    fn a_manifest_path_that_escapes_the_package_is_refused() {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        let data = r#"{
          "name": "@fezchat/evil", "version": "0.0.1",
          "fez": {"type": "extension", "parts": {"gui": "../evil.js"}}
        }"#;
        h.set_size(data.len() as u64); h.set_mode(0o644); h.set_cksum();
        b.append_data(&mut h, "package/package.json", data.as_bytes()).unwrap();
        let mut h2 = tar::Header::new_gnu();
        let evil = "haha\n";
        h2.set_size(evil.len() as u64); h2.set_mode(0o644); h2.set_cksum();
        b.append_data(&mut h2, "evil.js", evil.as_bytes()).unwrap();
        let tar_bytes = b.into_inner().unwrap();

        let home = tempfile::tempdir().unwrap();
        let err = install_from_tarball("@fezchat/evil", &tar_bytes, "0.0.1", home.path())
            .expect_err("a traversal path must be refused, not silently written");
        assert!(err.contains("escapes"), "unexpected error: {err}");
        // Nothing landed outside the package dir.
        assert!(!home.path().join("evil.js").exists());
        // ...nor was the package dir itself left holding a partial write.
        assert!(!home.path().join("packages").join("evil").join("evil.js").exists());
    }

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

    // Pins the property migration and install both rely on: the target path
    // is either fully absent/old, or fully the new bytes — never a torn
    // write in between — and no ".tmp" sibling is left behind afterward.
    #[test]
    fn write_atomic_leaves_no_torn_file_and_no_tmp_leftover() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("package.json");
        write_atomic(&target, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"a\":1}");
        assert!(!dir.path().join("package.tmp").exists());

        // A second write over an existing target is still all-or-nothing.
        write_atomic(&target, b"{\"a\":2}").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"a\":2}");
        assert!(!dir.path().join("package.tmp").exists());
    }

    #[test]
    fn version_reads_from_the_package_dir() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        assert_eq!(installed_version("tidy", home.path()).as_deref(), Some("0.0.1"));
    }

    // `base` can arrive straight from the webview (spawn_extension_agent's
    // `extension`), same as `remove_extension`/`package_info` guard before
    // touching disk — a traversal-shaped name must not resolve outside
    // packages/, even if some other `../../evil/package.json` happens to
    // exist.
    #[test]
    fn a_traversal_shaped_base_reads_no_manifest() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        std::fs::create_dir_all(home.path().join("evil")).unwrap();
        std::fs::write(home.path().join("evil").join("package.json"), r#"{"name":"evil"}"#).unwrap();
        assert!(installed_manifest("../evil", home.path()).is_none());
    }
}
