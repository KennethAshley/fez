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
        if entry.header().entry_type().is_file() && path.strip_prefix("package").ok() == Some(std::path::Path::new(rel)) {
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

fn safe_relative_path(rel: &str) -> bool {
    !rel.is_empty() && !rel.contains('\\') && !rel.chars().any(char::is_control)
        && rel.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn no_symlinks_below(root: &Path, rel: &Path) -> Result<(), String> {
    let mut path = root.to_path_buf();
    for component in rel.components() {
        if !matches!(component, std::path::Component::Normal(_)) { return Err("unsafe skill path".into()); }
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("skill paths must not contain filesystem symlinks".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn regular_tree(path: &Path, depth: usize) -> Result<(), String> {
    if depth > 64 { return Err("skill directory is too deeply nested".into()); }
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.is_file() { return Ok(()); }
    if !meta.is_dir() { return Err("skill content must contain only regular files and directories".into()); }
    for child in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        regular_tree(&child.map_err(|e| e.to_string())?.path(), depth + 1)?;
    }
    Ok(())
}

/// Complete regular-file payload under a declared skill directory. Preflight
/// rejects archive links, traversal and duplicate paths before any disk write.
fn skill_paths(tar_bytes: &[u8], dir: &str) -> Result<Vec<String>, String> {
    if !safe_relative_path(dir) || matches!(dir.split('/').next(), Some("package.json" | "package.tmp")) {
        return Err("skills directory escapes the package or is invalid".into());
    }
    let mut out = std::collections::BTreeSet::new();
    let mut seen = std::collections::BTreeMap::new();
    let mut archive = tar::Archive::new(tar_bytes);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let raw = entry.path_bytes();
        let raw = std::str::from_utf8(&raw).map_err(|_| "non-UTF8 archive path")?;
        let Some(rel) = raw.strip_prefix("package/") else { continue };
        if rel.is_empty() { continue; }
        let is_dir = entry.header().entry_type().is_dir();
        let rel = if is_dir { rel.trim_end_matches('/') } else { rel };
        if !safe_relative_path(rel) { return Err("unsafe archive path".into()); }
        if !Path::new(rel).starts_with(dir) { continue; }
        if seen.insert(rel.to_string(), is_dir).is_some_and(|previous| previous != is_dir || !is_dir) {
            return Err("duplicate or conflicting skill archive paths".into());
        }
        if is_dir { continue; }
        if rel == dir || !entry.header().entry_type().is_file() { return Err("skill archive content must be regular files, not links".into()); }
        entry.header().mode().map_err(|e| e.to_string())?;
        if !out.insert(rel.to_string()) { return Err("duplicate skill archive path".into()); }
    }
    // Reject a regular-file ancestor (e.g. skills/a and skills/a/SKILL.md).
    for rel in &out {
        for parent in Path::new(rel).ancestors().skip(1) {
            if out.contains(&parent.to_string_lossy().to_string()) { return Err("conflicting skill archive paths".into()); }
        }
    }
    Ok(out.into_iter().collect())
}

pub(crate) fn tar_list_paths(tar_bytes: &[u8], dir: &str) -> Vec<String> {
    skill_paths(tar_bytes, dir).unwrap_or_default()
}

fn skill_entrypoint(rel: &str, dir: &str) -> bool {
    let Ok(path) = Path::new(rel).strip_prefix(dir) else { return false };
    path.file_name().is_some_and(|name| name == "SKILL.md")
        || (path.components().count() == 1 && path.extension().is_some_and(|ext| ext == "md"))
}

#[cfg(unix)]
fn skill_file_mode(tar_bytes: &[u8], rel: &str) -> Result<u32, String> {
    let mut archive = tar::Archive::new(tar_bytes);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().map_err(|e| e.to_string())?.strip_prefix("package").ok() == Some(Path::new(rel)) {
            let mode = entry.header().mode().map_err(|e| e.to_string())?;
            return Ok(if mode & 0o111 != 0 { 0o755 } else { 0o644 });
        }
    }
    Err("skill file missing from archive".into())
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
    if !safe_relative_path(rel) {
        return Err(format!("{missing_ctx} path {rel} escapes the package — refusing"));
    }
    no_symlinks_below(pkg_dir, Path::new(rel))?;
    let bytes = tar_read(tar_bytes, rel).ok_or_else(|| format!("{missing_ctx} {rel} missing from tarball"))?;
    let dest = pkg_dir.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Whether a manifest declares anything install_from_tarball would
/// actually place on disk — checked BEFORE any write, so a package with
/// none of these can be refused with nothing left behind. Reads the
/// tarball for personas (tar_list_md doesn't write anything) but never
/// materializes a part just to check for its existence.
pub(crate) fn has_installable_content(pkg: &serde_json::Value, tar_bytes: &[u8]) -> bool {
    let parts = pkg.pointer("/fez/parts");
    let has_code_or_skill_part = ["gui", "headless", "relay", "workspace", "miner", "skill"]
        .iter()
        .any(|k| parts.and_then(|p| p.get(k)).is_some());
    let has_bin = pkg.get("bin").and_then(|v| v.as_object()).is_some_and(|m| !m.is_empty());
    let has_persona = pkg.pointer("/fez/personas").is_some_and(|_| {
        let dir = pkg.pointer("/fez/personas/dir").and_then(|v| v.as_str()).unwrap_or("personas");
        tar_list_md(tar_bytes, dir).iter().any(|(_, content)| content.contains("harness:"))
    });
    let has_skills = pkg.pointer("/fez/skills").is_some_and(|v| {
        let dir = v.get("dir").and_then(|d| d.as_str()).unwrap_or("skills");
        tar_list_paths(tar_bytes, dir).iter().any(|rel| skill_entrypoint(rel, dir))
    });
    has_code_or_skill_part || has_bin || has_persona || has_skills
}

/// Place an already-fetched, already-gated npm tarball into
/// `~/.fez/packages/<base>/` and index it into the flat dirs. Does NOT
/// touch settings.json — the caller feeds the returned `InstallOutcome`
/// into its own `update_settings` call.
pub(crate) fn install_from_tarball(
    name: &str,
    tar_bytes: &[u8],
    version: &str,
    home: &Path,
) -> Result<InstallOutcome, String> {
    let pkg_bytes = tar_read(tar_bytes, "package.json").ok_or("no package.json in tarball")?;
    let pkg: serde_json::Value =
        serde_json::from_slice(&pkg_bytes).map_err(|e| format!("bad package.json: {e}"))?;

    // De-scoped basename is the file/extension name: @fezchat/kanban → kanban.
    let base = name.rsplit('/').next().unwrap_or(name).trim_start_matches('@').to_string();
    let parts = pkg.pointer("/fez/parts");
    if base.is_empty() || !base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err("invalid package directory name".into());
    }
    // Full manifest identity, never a stripped prefix: two IDs would split
    // this package's data, grants and agent attachments.
    if let (Some(manifest_name), Ok(entries)) = (pkg.get("name").and_then(|v| v.as_str()), std::fs::read_dir(home.join("packages"))) {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            if id == base { continue; }
            // CLI install IDs can include dots; the scanned entry already bounds the path.
            let Some(installed) = std::fs::read(entry.path().join("package.json")).ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()) else { continue };
            if installed.pointer("/fez/reconstructed").and_then(|v| v.as_bool()) == Some(true) { continue; }
            if installed.get("name").and_then(|v| v.as_str()) == Some(manifest_name) {
                return Err(format!("{manifest_name} is already installed as {id}; consolidate its data and agent attachments under {base} before installing."));
            }
        }
    }
    let skill_payload = if let Some(config) = pkg.pointer("/fez/skills") {
        let dir = config.get("dir").and_then(|v| v.as_str()).unwrap_or("skills");
        let paths = skill_paths(tar_bytes, dir)?;
        let rel = Path::new("packages").join(&base).join(dir);
        no_symlinks_below(home, &rel)?;
        let target = home.join(rel);
        if target.exists() {
            if !target.is_dir() { return Err("installed skills path must be a directory".into()); }
            regular_tree(&target, 0)?;
        }
        Some((dir.to_string(), paths))
    } else { None };
    no_symlinks_below(home, &Path::new("packages").join(&base).join("package.json"))?;
    no_symlinks_below(home, &Path::new("packages").join(&base).join("package.tmp"))?;

    // Emptiness check BEFORE any write — this used to run in lib.rs
    // AFTER install_from_tarball had already written packages/<base>/package.json,
    // leaving an orphan dir that read_extension_versions surfaced as a
    // phantom row for a package that installed nothing.
    if !has_installable_content(&pkg, tar_bytes) {
        return Err(format!(
            "{name}@{version} has no installable gui/headless/relay/workspace/miner/persona/skill part"
        ));
    }

    // Bin-collision check BEFORE any write, mirroring the CLI's binOwner
    // check (installBins in package-manager.ts): a second package
    // claiming a command name already owned by another package must be
    // refused, naming the owner — not silently steal ~/.fez/bin/<cmd> via
    // link_index's remove_file + symlink. Checking this before the
    // package dir is even created keeps a refused install from leaving a
    // phantom packages/<base>/ behind.
    if let Some(bins) = pkg.get("bin").and_then(|v| v.as_object()) {
        let packages_dir = home.join("packages");
        for cmd in bins.keys() {
            if !safe_bin_name(cmd) {
                continue;
            }
            if let Some(owner) = bin_owner(&home.join("bin").join(cmd), &packages_dir) {
                if owner != base {
                    return Err(format!("bin \"{cmd}\" is already installed by {owner} — refusing"));
                }
            }
        }
    }

    let pkg_dir = home.join("packages").join(&base);
    std::fs::create_dir_all(&pkg_dir).map_err(|e| e.to_string())?;

    // The manifest as installed, verbatim — the package dir's own record
    // (mirrors the CLI's writePackageManifest). Atomic: package.json's mere
    // existence is what Task 7's migration (and any reader via
    // `installed_manifest`) treats as "this package is fully installed" —
    // a torn write from a mid-write crash must never be observable there.
    write_atomic(&pkg_dir.join("package.json"), &pkg_bytes).map_err(|e| e.to_string())?;

    let mut installed: Vec<String> = Vec::new();

    // Code parts: materialize into the package dir. gui is loaded straight
    // from the package dir via the manifest (the webview's loader, gui_parts
    // above) — it gets no flat symlink. The other code parts still get one, same
    // as before.
    for (part_key, dir) in [
        ("gui", "gui-extensions"),
        ("headless", "extensions"),
        ("relay", "relay-extensions"),
        ("workspace", "workspace-providers"),
        ("miner", "miners"),
    ] {
        let rel = match parts.and_then(|p| p.get(part_key)).and_then(|v| v.as_str()) {
            Some(r) => r,
            None => continue,
        };
        let dest = materialize(tar_bytes, &pkg_dir, rel, part_key)?;
        if part_key == "gui" {
            // The gui part's companion stylesheet: `fez pack` emits a hashed
            // `<stem>.css` beside `<stem>.js`, and gui_parts() reads that
            // sibling from the package dir at load time — but nothing ever
            // PUT it there. Only the manifest-named file was materialized,
            // so a CSS-Modules panel (ridges, live) installed from the
            // gallery rendered as bare markup. Best-effort: most extensions
            // ship none, and an absent tarball entry is not an error.
            if let Some(stem) = rel.strip_suffix(".js") {
                let _ = materialize(tar_bytes, &pkg_dir, &format!("{stem}.css"), part_key);
            }
            installed.push(format!("gui → packages/{base}/{rel}"));
            continue;
        }
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

    // Replace only the package-owned skills tree; personal skill copies are
    // independent. The complete archive and destination were preflighted above.
    if let Some((dir, paths)) = skill_payload {
        let target = pkg_dir.join(&dir);
        if target.exists() { std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?; }
        for rel in paths {
            let dest = materialize(tar_bytes, &pkg_dir, &rel, "skill")?;
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dest, std::fs::Permissions::from_mode(skill_file_mode(tar_bytes, &rel)?)).map_err(|e| e.to_string())?;
            }
            if skill_entrypoint(&rel, &dir) {
                let entry = Path::new(&rel);
                let id = if entry.file_name().is_some_and(|n| n == "SKILL.md") { entry.parent().and_then(Path::file_name) } else { entry.file_stem() }.and_then(|v| v.to_str()).unwrap_or("skill");
                installed.push(format!("skill {id} → packages/{base}/{rel}"));
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

/// The package that owns a flat-dir entry (bin, gui-extensions, ...), or
/// `None` if nobody does — mirrors the CLI's `binOwner`. Ownership is
/// structural, never by name: a symlink whose canonicalized target
/// resolves under the canonicalized `packages_dir` is owned by the first
/// path component under it; a regular file (legacy layout, or a
/// copy-fallback), a broken symlink, or one that resolves somewhere else
/// entirely is unowned. Both sides get canonicalized — on macOS `/var` is
/// itself a symlink to `/private/var`, so a tempdir-rooted `home` resolves
/// the entry there while an un-canonicalized `packages` dir still reads
/// `/var/...`, and a prefix check across that mismatch would silently
/// treat every package as unowned. Shared by the pre-install collision
/// check and `remove_if_owned` — one ownership rule, not two.
fn bin_owner(entry: &Path, packages_dir: &Path) -> Option<String> {
    let is_symlink = std::fs::symlink_metadata(entry).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if !is_symlink {
        return None;
    }
    let real = std::fs::canonicalize(entry).ok()?;
    let real_packages = std::fs::canonicalize(packages_dir).ok()?;
    let owner = real.strip_prefix(&real_packages).ok()?.components().next()?;
    Some(owner.as_os_str().to_string_lossy().into_owned())
}

/// Delete an index entry iff `base` still owns it (see `bin_owner`). A
/// foreign or already-absent entry is left alone.
pub(crate) fn remove_if_owned(entry: &Path, base: &str, packages_dir: &Path) -> bool {
    if bin_owner(entry, packages_dir).as_deref() != Some(base) {
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
        ("miner", "miners"),
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

/// GUI extension parts, sourced from `packages/*/` rather than the
/// `gui-extensions/` symlink index — one package dir per name, its own
/// manifest says whether it has a gui part. A dir with no `fez.parts.gui`
/// or an unreadable bundle is skipped, not an error: a package that
/// legitimately has no GUI part is not a broken install.
pub(crate) fn gui_parts(home: &Path) -> Vec<(String, String, String, Option<String>)> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(home.join("packages")) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let manifest = match installed_manifest(&name, home) {
            Some(m) => m,
            None => continue,
        };
        let rel = match manifest.pointer("/fez/parts/gui").and_then(|v| v.as_str()) {
            Some(r) => r,
            None => continue,
        };
        // Same guard as materialize's write-time check — a manifest sitting
        // in packages/*/ isn't necessarily one install_from_tarball wrote
        // (hand-edited, synced, or pre-guard), so a traversal rel is
        // refused here too rather than trusted to read outside the package.
        if rel.starts_with('/') || Path::new(rel).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        if let Ok(code) = std::fs::read_to_string(home.join("packages").join(&name).join(rel)) {
            // A gui part's companion CSS: `fez pack` emits a hashed `<gui>.css`
            // beside `<gui>.js`. Read it when present so the webview loader can
            // inject it; most extensions ship none, so an absent file is an
            // empty string, not an error. `rel` already passed the traversal
            // guard above, and the `.css` sibling derives from it.
            let styles = rel
                .strip_suffix(".js")
                .and_then(|stem| {
                    std::fs::read_to_string(home.join("packages").join(&name).join(format!("{stem}.css"))).ok()
                })
                .unwrap_or_default();
            // Only absence means legacy. A malformed declaration must reach
            // the loader as unsupported, never silently run in main.
            let runtime = manifest.pointer("/fez/guiRuntime")
                .map(|value| value.as_str().unwrap_or("invalid").to_owned());
            out.push((name, code, styles, runtime));
        }
    }
    out
}

/// Every extension with a headless, gui, miner, and/or skills part, keyed by
/// package name — the desktop UI's installed-extension list (lib.rs's
/// `list_local_extensions` tauri command is a thin wrapper over this).
/// Headless still comes from the flat `extensions/` symlink index —
/// unaffected by this task; gui comes from `gui_parts` (packages/*/ + each
/// manifest's `fez.parts.gui`), not the `gui-extensions/` symlink dir, which
/// install no longer populates. Skills come from each manifest's
/// `fez.skills` — a skill-only package (no headless/gui part) would
/// otherwise have no row in this list at all.
pub(crate) fn local_extensions(home: &Path) -> Vec<(String, Vec<String>)> {
    let mut map: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    if let Ok(entries) = std::fs::read_dir(home.join("extensions")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("js") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    map.entry(stem.to_string()).or_default().push("headless".to_string());
                }
            }
        }
    }
    for (name, _, _, _) in gui_parts(home) {
        map.entry(name).or_default().push("gui".to_string());
    }
    if let Ok(entries) = std::fs::read_dir(home.join("packages")) {
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            let Some(manifest) = installed_manifest(&name, home) else { continue };
            if manifest.pointer("/fez/parts/miner").and_then(|value| value.as_str()).is_some() {
                map.entry(name.clone()).or_default().push("miner".to_string());
            }
            if manifest.pointer("/fez/skills").is_some() {
                map.entry(name).or_default().push("skills".to_string());
            }
        }
    }
    map.into_iter().collect()
}

/// One discovered skill, for the webview's install manager. No `path` —
/// the webview never needs one (mirrors the CLI's `InstalledSkill`, minus
/// the `path` field the CLI keeps for its own filesystem callers).
#[derive(Debug, serde::Serialize)]
pub(crate) struct InstalledSkill {
    pub pkg: String,
    /// The pack's human name — the repo a git install came from ("ponytail"),
    /// falling back to the package name. What a picker labels the PACK with;
    /// `gh-dietrichgebert-ponytail` is an address, not a title.
    pub title: String,
    pub id: String,
    pub name: String,
    pub description: String,
    /// Declared setting choices (`options:` frontmatter) — empty when the skill declares none.
    pub options: Vec<String>,
    #[serde(rename = "disableModelInvocation")]
    pub disable_model_invocation: bool,
}

fn skill_scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<String>(value).unwrap_or_else(|_| value.to_string());
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return value[1..value.len()-1].replace("''", "'");
    }
    value.to_string()
}

fn skill_options(value: &str) -> Vec<String> {
    let value = value.trim();
    let value = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')).unwrap_or(value);
    let mut parts = Vec::new(); let mut part = String::new(); let mut quote = None; let mut escaped = false;
    for c in value.chars() {
        if escaped { part.push(c); escaped = false; continue; }
        if c == '\\' && quote == Some('"') { part.push(c); escaped = true; continue; }
        if c == '\'' || c == '"' {
            if quote == Some(c) { quote = None; } else if quote.is_none() { quote = Some(c); }
        }
        if c == ',' && quote.is_none() { parts.push(skill_scalar(&part)); part.clear(); }
        else { part.push(c); }
    }
    if quote.is_some() { return Vec::new(); }
    parts.push(skill_scalar(&part));
    parts.into_iter().filter(|v| !v.is_empty()).collect()
}

/// Bounded frontmatter subset shared by native import preview and discovery.
/// Display scalars collapse whitespace; the source SKILL.md remains unchanged.
/// An invalid manual-only flag fails closed instead of enabling model invocation.
pub(crate) fn skill_frontmatter(content: &str, stem: &str) -> (String, String, Vec<String>, bool) {
    let content = content.replace("\r\n", "\n");
    let lines: Vec<&str> = content.lines().collect();
    let defaults = || (stem.to_string(), String::new(), Vec::new(), false);
    if lines.first() != Some(&"---") { return defaults(); }
    let Some(end) = lines.iter().skip(1).position(|line| *line == "---").map(|i| i + 1) else { return defaults() };
    let (mut name, mut description, mut options, mut manual) = defaults();
    let mut i = 1;
    while i < end {
        let line = lines[i];
        if line.starts_with(char::is_whitespace) { i += 1; continue; }
        let Some((key, raw)) = line.split_once(':') else { i += 1; continue };
        let raw = raw.trim();
        if key == "options" && raw.is_empty() {
            options.clear();
            while i + 1 < end && (lines[i+1].starts_with(char::is_whitespace) || lines[i+1].trim().is_empty()) {
                i += 1;
                if let Some(value) = lines[i].trim().strip_prefix("- ") {
                    let value = skill_scalar(value); if !value.is_empty() { options.push(value); }
                }
            }
        } else if key == "options" {
            options = skill_options(raw);
        } else if key == "disable-model-invocation" {
            manual = skill_scalar(raw).to_lowercase() != "false";
        } else if key == "name" || key == "description" {
            let value = if matches!(raw, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
                let mut parts = Vec::new();
                while i + 1 < end && (lines[i+1].starts_with(char::is_whitespace) || lines[i+1].trim().is_empty()) {
                    i += 1; parts.push(lines[i].trim());
                }
                parts.join(" ")
            } else { skill_scalar(raw) };
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
            if key == "name" { name = value; } else { description = value; }
        }
        i += 1;
    }
    if name.is_empty() { name = stem.to_string(); }
    (name, description, options, manual)
}

/// Category folders may nest; the first SKILL.md establishes a skill root.
/// Markdown below that root is supporting material, never another skill.
fn skill_entry_files(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, PathBuf)>) {
    if depth > 64 { return; }
    let entrypoint = dir.join("SKILL.md");
    if entrypoint.is_file() {
        let relative = dir.strip_prefix(root).unwrap_or(dir);
        let id = if relative.as_os_str().is_empty() { dir.file_name().unwrap_or_default().to_string_lossy().to_string() }
            else { relative.to_string_lossy().replace('\\', "/") };
        out.push((id, entrypoint)); return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() { skill_entry_files(root, &path, depth + 1, out); }
        else if depth == 0 && path.extension().is_some_and(|ext| ext == "md") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) { out.push((stem.to_string(), path)); }
        }
    }
}

/// Walk `packages/*/package.json` for `fez.skills` and read each `.md`'s
/// frontmatter — the desktop mirror of the CLI's `skillsInstalled`
/// (skills-md.ts). A skill with no `description:` is skipped (required
/// field, same rule both sides enforce).
pub(crate) fn installed_skills(home: &Path) -> Vec<InstalledSkill> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(home.join("packages")) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let pkg_name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if no_symlinks_below(home, &Path::new("packages").join(&pkg_name).join("package.json")).is_err() {
            eprintln!("Skipping skills package: linked package or manifest"); continue;
        }
        let manifest = match installed_manifest(&pkg_name, home) {
            Some(m) => m,
            None => continue,
        };
        let Some(skills_cfg) = manifest.pointer("/fez/skills") else { continue };
        let title = manifest
            .pointer("/fez/gitSource/url")
            .and_then(|v| v.as_str())
            // Installs made from a sha-pinned card stored "…/repo#<sha>" —
            // the fragment is provenance, not name. Strip it here so packs
            // installed before the canonical-url fix still title cleanly.
            .map(|u| u.split('#').next().unwrap_or(u))
            .and_then(|u| u.trim_end_matches('/').rsplit('/').next())
            .filter(|t| !t.is_empty())
            .unwrap_or(&pkg_name)
            .to_string();
        let dir = skills_cfg.get("dir").and_then(|v| v.as_str()).unwrap_or("skills");
        if !safe_relative_path(dir) { continue; }
        let relative = Path::new("packages").join(&pkg_name).join(dir);
        if no_symlinks_below(home, &relative).is_err() {
            eprintln!("Skipping skills package {pkg_name}: linked skills directory"); continue;
        }
        let skills_dir = home.join(relative);
        if !skills_dir.exists() { continue; }
        if let Err(error) = regular_tree(&skills_dir, 0) {
            eprintln!("Skipping skills package {pkg_name}: {error}"); continue;
        }
        let mut files = Vec::new();
        skill_entry_files(&skills_dir, &skills_dir, 0, &mut files);
        files.sort_by(|a,b| a.0.cmp(&b.0));
        for (id, path) in files {
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            let (name, description, options, disable_model_invocation) = skill_frontmatter(&content, &id);
            if description.is_empty() { continue; }
            out.push(InstalledSkill { pkg: pkg_name.clone(), title: title.clone(), id, name, description, options, disable_model_invocation });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn miner_only_package_installs_and_removes_its_descriptor() {
        let home = tempfile::tempdir().unwrap();
        let mut archive = tar::Builder::new(Vec::new());
        for (path, content) in [
            ("package/package.json", r#"{"name":"@fezchat/numinous","fez":{"type":"extension","parts":{"miner":"dist/miner.js"}}}"#),
            ("package/dist/miner.js", "export default [{ netuid: 155 }];"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64); header.set_mode(0o644); header.set_cksum();
            archive.append_data(&mut header, path, content.as_bytes()).unwrap();
        }
        let out = install_from_tarball("@fezchat/numinous", &archive.into_inner().unwrap(), "0.1.0", home.path()).unwrap();
        assert!(out.installed.iter().any(|line| line.starts_with("miner →")));
        let descriptor = home.path().join("miners/numinous.js");
        assert_eq!(std::fs::read_to_string(&descriptor).unwrap(), "export default [{ netuid: 155 }];");
        assert!(std::fs::canonicalize(&descriptor).unwrap().starts_with(std::fs::canonicalize(home.path().join("packages/numinous")).unwrap()));
        assert_eq!(local_extensions(home.path()), vec![("numinous".to_string(), vec!["miner".to_string()])]);
        remove_installed("numinous", home.path()).unwrap();
        assert!(std::fs::symlink_metadata(&descriptor).is_err());
        assert!(local_extensions(home.path()).is_empty());
    }

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
    fn refuses_an_existing_full_package_identity_under_another_id_before_writing() {
        for id in ["fez-tidy", "tidy.dev"] {
            let home = tempfile::tempdir().unwrap();
            let alias = home.path().join("packages").join(id);
            std::fs::create_dir_all(&alias).unwrap();
            let manifest = tar_read(&fixture_tar(), "package.json").unwrap();
            std::fs::write(alias.join("package.json"), &manifest).unwrap();
            let error = install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap_err();
            assert!(error.contains(&format!("@fezchat/tidy is already installed as {id}")), "{error}");
            assert!(!home.path().join("packages/tidy").exists());
            assert!(!home.path().join("extensions").exists());
            assert_eq!(std::fs::read(alias.join("package.json")).unwrap(), manifest);
        }
    }

    #[test]
    fn full_identity_guard_allows_other_scopes_reconstructed_names_and_in_place_updates() {
        let home = tempfile::tempdir().unwrap();
        for (id, manifest) in [
            ("other-tidy", serde_json::json!({"name": "@other/tidy"})),
            ("fez-tidy", serde_json::json!({"name": "@fezchat/tidy", "fez": {"reconstructed": true}})),
        ] {
            let dir = home.path().join("packages").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("package.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        }
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.2", home.path()).unwrap();
        assert!(home.path().join("packages/other-tidy/package.json").exists());
    }

    // THE LAYOUT CONTRACT — must match packages/fez-evals/tests/package-lifecycle.test.ts exactly.
    // packages/<base>/package.json         the manifest, as installed
    // packages/<base>/dist/<part>.js       real part files (gui/headless/relay/workspace)
    // packages/<base>/bin/<cmd>            real binaries (0755)
    // <flat dir>/<base>.js  -> symlink into packages/<base>/   (extensions/relay-extensions/workspace-providers — NOT gui, the loader reads packages/*/ + the manifest directly)
    // bin/<cmd>             -> symlink into packages/<base>/
    #[test]
    fn installs_into_a_package_dir_with_a_symlink_index() {
        let home = tempfile::tempdir().unwrap(); // add tempfile dev-dep if absent
        let out = install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        assert_eq!(out.base, "tidy");
        let pkg = home.path().join("packages").join("tidy");
        let pkg_real = std::fs::canonicalize(&pkg).unwrap();

        // packages/<base>/package.json — the manifest, as installed (and it parses).
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(pkg.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "@fezchat/tidy");

        // packages/<base>/dist/<part>.js — real part files.
        assert!(pkg.join("dist/gui.js").exists());
        assert!(pkg.join("dist/headless.js").exists());

        // <flat dir>/<base>.js and bin/<cmd> -> symlinks into packages/<base>/.
        // gui gets none — the loader reads packages/*/ + the manifest directly.
        for (dir, f) in [("extensions","tidy.js"), ("bin","tidy-tool"), ("bin","clix")] {
            let p = home.path().join(dir).join(f);
            let md = std::fs::symlink_metadata(&p).unwrap();
            assert!(md.file_type().is_symlink(), "{dir}/{f} must be a symlink");
            assert!(std::fs::canonicalize(&p).unwrap().starts_with(&pkg_real));
        }
        assert!(!home.path().join("gui-extensions").join("tidy.js").exists(), "gui must not get a flat symlink");

        // packages/<base>/bin/<cmd> — every declared bin, real and chmod 0755.
        // "clix": "bin/index.js" in particular — a source file that does NOT
        // already sit at bin/<cmd> — must still land a canonical
        // packages/<base>/bin/clix copy, not a copy under its source basename.
        use std::os::unix::fs::PermissionsExt;
        for cmd in ["tidy-tool", "clix"] {
            let p = pkg.join("bin").join(cmd);
            assert!(p.exists(), "packages/tidy/bin/{cmd} must exist");
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o755, "{cmd} must be 0755");
        }

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

    fn fixture_tar_clash() -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        let add = |b: &mut tar::Builder<Vec<u8>>, path: &str, data: &str| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64); h.set_mode(0o644); h.set_cksum();
            b.append_data(&mut h, path, data.as_bytes()).unwrap();
        };
        add(&mut b, "package/package.json", r#"{
          "name": "@fezchat/clash", "version": "0.0.1",
          "bin": {"tidy-tool": "dist/tool.js"},
          "fez": {"type": "extension"}
        }"#);
        add(&mut b, "package/dist/tool.js", "#!/usr/bin/env node\n");
        b.into_inner().unwrap()
    }

    // The Rust mirror of the CLI's "a second package shipping the same
    // command is refused, naming the owner" — before this, install_from_tarball
    // had no ownership check at all: a second package silently stole
    // ~/.fez/bin/<cmd> from its owner via link_index's remove_file + symlink.
    #[test]
    fn a_second_package_shipping_the_same_bin_is_refused_naming_the_owner() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        let err = install_from_tarball("@fezchat/clash", &fixture_tar_clash(), "0.0.1", home.path())
            .expect_err("a second package claiming an already-owned bin must be refused");
        assert!(err.contains("tidy-tool"), "unexpected error: {err}");
        assert!(err.contains("tidy"), "error must name the owner: {err}");
        // the loser must not have written anything — refusal happens BEFORE
        // any package-dir or flat write, mirroring the CLI's ordering
        assert!(!home.path().join("packages").join("clash").exists());
        // the first package's symlink still resolves into its own dir
        let p = home.path().join("bin").join("tidy-tool");
        let pkg_real = std::fs::canonicalize(home.path().join("packages").join("tidy")).unwrap();
        assert!(std::fs::canonicalize(&p).unwrap().starts_with(&pkg_real));
    }

    // The emptiness check must fire BEFORE install_from_tarball writes
    // anything — previously lib.rs checked outcome.installed.is_empty()
    // AFTER install_from_tarball had already written packages/<base>/package.json,
    // leaving an orphan dir read_extension_versions would surface as a
    // phantom row.
    #[test]
    fn no_installable_part_is_refused_before_any_write() {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        let data = r#"{"name": "@fezchat/empty", "version": "0.0.1", "fez": {"type": "extension"}}"#;
        h.set_size(data.len() as u64); h.set_mode(0o644); h.set_cksum();
        b.append_data(&mut h, "package/package.json", data.as_bytes()).unwrap();
        let tar_bytes = b.into_inner().unwrap();

        let home = tempfile::tempdir().unwrap();
        let err = install_from_tarball("@fezchat/empty", &tar_bytes, "0.0.1", home.path())
            .expect_err("a package with no installable part must be refused");
        assert!(err.contains("no installable"), "unexpected error: {err}");
        assert!(!home.path().join("packages").join("empty").exists(), "nothing should be written on refusal");
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

    // The loader (Task 1) reads packages/*/ + the manifest directly, so
    // gui-extensions/<base>.js is dead weight install no longer needs to
    // create — install must still materialize the gui part INTO the
    // package dir (gui_parts and the webview loader both depend on that).
    #[test]
    fn install_creates_no_gui_extensions_symlink() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        assert!(!home.path().join("gui-extensions").join("tidy.js").exists());
        assert!(home.path().join("packages").join("tidy").join("dist").join("gui.js").exists());
    }

    // list_local_extensions (lib.rs) must keep reporting a gui extension
    // even though install no longer leaves a gui-extensions symlink behind
    // — it has to read gui presence from packages/*/ instead, same source
    // gui_parts already uses.
    #[test]
    fn local_extensions_reports_gui_from_the_package_dir_with_no_symlink() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        assert!(!home.path().join("gui-extensions").join("tidy.js").exists());
        let found = local_extensions(home.path());
        let tidy = found.iter().find(|(name, _)| name == "tidy").expect("tidy must be reported");
        assert!(tidy.1.contains(&"gui".to_string()), "must report the gui part: {:?}", tidy.1);
        assert!(tidy.1.contains(&"headless".to_string()), "must still report the headless part: {:?}", tidy.1);
    }

    // A skills-only package (no headless/gui part) must still get a row in
    // local_extensions, tagged "skills" — otherwise it has no listing, no
    // GUI uninstall, no give-to in the installed tab.
    #[test]
    fn local_extensions_reports_skills_only_packages() {
        let mut b = tar::Builder::new(Vec::new());
        let add = |b: &mut tar::Builder<Vec<u8>>, path: &str, data: &str| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64); h.set_mode(0o644); h.set_cksum();
            b.append_data(&mut h, path, data.as_bytes()).unwrap();
        };
        add(&mut b, "package/package.json", r#"{
          "name": "@fezchat/ponytail-pack", "version": "0.0.1",
          "fez": {"type": "extension", "skills": {"dir": "skills"}}
        }"#);
        add(&mut b, "package/skills/pony.md", "---\ndescription: lazy senior dev\n---\nBe lazy.\n");
        let tar_bytes = b.into_inner().unwrap();

        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/ponytail-pack", &tar_bytes, "0.0.1", home.path()).unwrap();

        let found = local_extensions(home.path());
        let pack = found.iter().find(|(name, _)| name == "ponytail-pack").expect("skills-only package must be listed");
        assert!(pack.1.contains(&"skills".to_string()), "must report the skills part: {:?}", pack.1);
    }

    #[test]
    fn gui_loader_reads_the_manifest_gui_part_from_the_package_dir() {
        let home = tempfile::tempdir().unwrap();
        // fixture_tar already declares fez.parts.gui = "dist/gui.js"
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        let found = gui_parts(home.path());               // the new pure scanner
        assert!(found.iter().any(|(name, code, _, _)| name == "tidy" && code.contains("export default")));
        // it is read from the package dir, and does NOT depend on gui-extensions/
        std::fs::remove_dir_all(home.path().join("gui-extensions")).ok();
        assert!(gui_parts(home.path()).iter().any(|(n, _, _, _)| n == "tidy"), "must not depend on the symlink dir");
    }

    #[test]
    fn gui_parts_preserves_runtime_selection_and_marks_invalid_declarations() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();
        let file = home.path().join("packages/tidy/package.json");
        let mut manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        for (runtime, expected) in [
            (serde_json::json!("isolated-settings"), "isolated-settings"),
            (serde_json::json!("future-runtime"), "future-runtime"),
            (serde_json::Value::Null, "invalid"),
            (serde_json::json!({}), "invalid"),
        ] {
            manifest["fez"]["guiRuntime"] = runtime;
            std::fs::write(&file, manifest.to_string()).unwrap();
            let parts = serde_json::to_value(gui_parts(home.path())).unwrap();
            assert_eq!(parts[0][3], expected);
        }
        manifest["fez"].as_object_mut().unwrap().remove("guiRuntime");
        std::fs::write(&file, manifest.to_string()).unwrap();
        assert_eq!(serde_json::to_value(gui_parts(home.path())).unwrap()[0][3], serde_json::Value::Null);
    }

    // install_from_tarball already refuses a traversal `gui` rel at write
    // time (a_manifest_path_that_escapes_the_package_is_refused), but
    // gui_parts reads whatever manifest is sitting in packages/*/ — a
    // hand-edited or pre-guard manifest is not out of scope. Same guard,
    // at read time, so a package like this yields no gui part rather than
    // reading a file outside its own package dir.
    #[test]
    fn gui_parts_refuses_a_manifest_gui_rel_that_escapes_the_package() {
        let home = tempfile::tempdir().unwrap();
        let pkg_dir = home.path().join("packages").join("evil");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            r#"{"name": "@fezchat/evil", "version": "0.0.1", "fez": {"type": "extension", "parts": {"gui": "../evil.js"}}}"#,
        )
        .unwrap();
        std::fs::write(home.path().join("packages").join("evil.js"), "haha\n").unwrap();

        let found = gui_parts(home.path());
        assert!(found.iter().all(|(n, _, _, _)| n != "evil"), "a traversal gui rel must yield no gui part: {found:?}");
    }

    // fez pack emits a hashed `<gui>.css` beside `<gui>.js`; gui_parts must
    // return it as the 3rd tuple element so the webview loader can inject it.
    // Most extensions ship none — an absent file is an empty string.
    #[test]
    fn gui_parts_reads_the_companion_css_beside_the_gui_part() {
        let home = tempfile::tempdir().unwrap();
        install_from_tarball("@fezchat/tidy", &fixture_tar(), "0.0.1", home.path()).unwrap();

        // No companion css yet → empty styles, not an error.
        let none = gui_parts(home.path());
        let (_, _, styles, _) = none.iter().find(|(n, _, _, _)| n == "tidy").expect("tidy");
        assert_eq!(styles, "", "no companion css → empty styles");

        // Write dist/gui.css beside the fixture's dist/gui.js → it is read.
        let css = home.path().join("packages").join("tidy").join("dist").join("gui.css");
        std::fs::write(&css, ".fez-tidy-x{color:red}\n").unwrap();
        let with = gui_parts(home.path());
        let (_, _, styles, _) = with.iter().find(|(n, _, _, _)| n == "tidy").expect("tidy");
        assert!(styles.contains(".fez-tidy-x"), "companion css must be read: {styles:?}");
    }

    #[test]
    fn a_skills_package_installs_md_into_the_package_dir() {
        let mut b = tar::Builder::new(Vec::new());
        let add = |b: &mut tar::Builder<Vec<u8>>, path: &str, data: &str| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64); h.set_mode(0o644); h.set_cksum();
            b.append_data(&mut h, path, data.as_bytes()).unwrap();
        };
        add(&mut b, "package/package.json", r#"{
          "name": "@fezchat/ponytail-pack", "version": "0.0.1",
          "fez": {"type": "extension", "skills": {"dir": "skills"}}
        }"#);
        add(&mut b, "package/skills/pony.md", "---\ndescription: lazy senior dev\n---\nBe lazy.\n");
        let tar_bytes = b.into_inner().unwrap();

        let home = tempfile::tempdir().unwrap();
        let out = install_from_tarball("@fezchat/ponytail-pack", &tar_bytes, "0.0.1", home.path()).unwrap();
        assert!(out.installed.iter().any(|l| l.contains("skill pony")), "unexpected: {:?}", out.installed);
        assert!(home.path().join("packages/ponytail-pack/skills/pony.md").exists());
        assert!(!home.path().join("skills").exists(), "no legacy ~/.fez/skills/ dir must be created");
    }

    #[test]
    fn installed_skills_reads_frontmatter_and_skips_missing_description() {
        let home = tempfile::tempdir().unwrap();
        let skills_dir = home.path().join("packages/ponytail-pack/skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            home.path().join("packages/ponytail-pack/package.json"),
            r#"{"name": "@fezchat/ponytail-pack", "version": "0.0.1", "fez": {"type": "extension", "skills": {"dir": "skills"}}}"#,
        )
        .unwrap();
        std::fs::write(skills_dir.join("pony.md"), "---\ndescription: lazy senior dev\n---\nBe lazy.").unwrap();
        std::fs::write(skills_dir.join("no-desc.md"), "No frontmatter.").unwrap();

        let found = installed_skills(home.path());
        assert_eq!(found.len(), 1, "description required; no-desc must be skipped: {found:?}");
        assert_eq!(found[0].pkg, "ponytail-pack");
        assert_eq!(found[0].id, "pony");
        assert_eq!(found[0].name, "pony"); // no `name:` in frontmatter → defaults to stem
        assert_eq!(found[0].description, "lazy senior dev");
    }

    #[test]
    fn installed_skills_refuses_a_dir_that_escapes_the_package() {
        let home = tempfile::tempdir().unwrap();
        let pkg_dir = home.path().join("packages/leaky");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(
            pkg_dir.join("package.json"),
            r#"{"name": "@fezchat/leaky", "version": "0.0.1", "fez": {"type": "extension", "skills": {"dir": "../evil"}}}"#,
        )
        .unwrap();
        // A readable dir OUTSIDE packages/leaky/, with a legit-shaped skill —
        // "../evil" from packages/leaky/ resolves to packages/evil/, a
        // sibling package's dir that "leaky" has no business reading.
        let evil = home.path().join("packages/evil");
        std::fs::create_dir_all(&evil).unwrap();
        std::fs::write(evil.join("secret.md"), "---\ndescription: leaked\n---\nx").unwrap();

        let found = installed_skills(home.path());
        assert!(found.is_empty(), "an escaping dir must yield zero skills: {found:?}");
    }

    #[test]
    fn skill_frontmatter_tolerates_crlf() {
        let (name, description, options, manual) = skill_frontmatter(
            "---\r\nname: The Pony\r\ndescription: lazy senior dev\r\noptions: [lite, full, ultra]\r\n---\r\nBe lazy.\r\n",
            "pony",
        );
        assert_eq!(name, "The Pony");
        assert_eq!(description, "lazy senior dev");
        assert_eq!(options, vec!["lite", "full", "ultra"]);
        assert!(!manual);
    }

    fn skill_archive(files: &[(&str, &[u8])], link: Option<&str>) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        let manifest = br#"{"name":"@fezchat/skill-pack","version":"1.0.0","fez":{"skills":{"dir":"skills"}}}"#;
        for (path, bytes) in std::iter::once(("package/package.json", manifest.as_slice())).chain(files.iter().copied()) {
            let mut h = tar::Header::new_gnu(); h.set_size(bytes.len() as u64); h.set_mode(if path.ends_with(".sh") { 0o4755 } else { 0o644 }); h.set_cksum();
            b.append_data(&mut h, path, bytes).unwrap();
        }
        if let Some(path) = link {
            let mut h = tar::Header::new_gnu(); h.set_entry_type(tar::EntryType::Symlink); h.set_size(0); h.set_mode(0o777); h.set_link_name("/tmp/outside").unwrap(); h.set_cksum();
            b.append_data(&mut h, path, &[][..]).unwrap();
        }
        b.into_inner().unwrap()
    }

    #[test]
    fn nested_skills_keep_complete_resources_and_discover_only_entrypoints() {
        let home = tempfile::tempdir().unwrap();
        let archive = skill_archive(&[
            ("package/skills/pony/SKILL.md", b"---\nname: 'Pony Skill'\ndescription: >-\n  useful tools\n  for a job\noptions: ['one,two', full]\ndisable-model-invocation: true\n---\nBody\n"),
            ("package/skills/pony/scripts/run.py", b"raise RuntimeError('never execute on install')\n"),
            ("package/skills/pony/assets/pixel.bin", &[0, 255, 1]),
            ("package/skills/pony/references/guide.md", b"---\ndescription: supporting material\n---\nx"),
            ("package/skills/flat.md", b"---\ndescription: legacy\n---\nx"),
        ], None);
        install_from_tarball("@fezchat/skill-pack", &archive, "1.0.0", home.path()).unwrap();
        assert_eq!(std::fs::read(home.path().join("packages/skill-pack/skills/pony/assets/pixel.bin")).unwrap(), vec![0,255,1]);
        assert!(home.path().join("packages/skill-pack/skills/pony/scripts/run.py").is_file());
        let found = installed_skills(home.path());
        assert_eq!(found.len(), 2);
        let pony = found.iter().find(|s| s.id == "pony").unwrap();
        assert_eq!(pony.name, "Pony Skill"); assert_eq!(pony.description, "useful tools for a job");
        assert_eq!(pony.options, vec!["one,two", "full"]);
        assert_eq!(serde_json::to_value(pony).unwrap()["disableModelInvocation"], true);
    }

    #[test]
    fn support_only_archive_and_symlink_payload_fail_before_installing_anything() {
        for archive in [
            skill_archive(&[("package/skills/pony/references/guide.md", b"---\ndescription: not a skill\n---\n")], None),
            skill_archive(&[("package/skills/pony/SKILL.md", b"---\ndescription: skill\n---\n")], Some("package/skills/pony/secret")),
        ] {
            let home = tempfile::tempdir().unwrap();
            assert!(install_from_tarball("@fezchat/skill-pack", &archive, "1", home.path()).is_err());
            assert!(!home.path().join("packages/skill-pack").exists());
        }
    }

    #[test]
    fn destination_symlinks_are_neither_written_nor_discovered() {
        let home = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        let pkg = home.path().join("packages/skill-pack"); std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(outside.path().join("flat.md"), "---\ndescription: private\n---\nx").unwrap();
        std::os::unix::fs::symlink(outside.path(), pkg.join("skills")).unwrap();
        let archive = skill_archive(&[("package/skills/flat.md", b"---\ndescription: public\n---\nx")], None);
        assert!(install_from_tarball("@fezchat/skill-pack", &archive, "1", home.path()).is_err());
        std::fs::write(pkg.join("package.json"), tar_read(&archive, "package.json").unwrap()).unwrap();
        assert!(installed_skills(home.path()).is_empty());
        assert!(std::fs::read_to_string(outside.path().join("flat.md")).unwrap().contains("private"));
    }

    #[test]
    fn updating_a_skill_removes_stale_packaged_files_and_preserves_personal_copies() {
        let home = tempfile::tempdir().unwrap();
        let first = skill_archive(&[("package/skills/pony/SKILL.md", b"---\ndescription: skill\n---\nx"), ("package/skills/pony/old.txt", b"old")], None);
        install_from_tarball("@fezchat/skill-pack", &first, "1", home.path()).unwrap();
        std::fs::create_dir_all(home.path().join("skills")).unwrap();
        std::fs::write(home.path().join("skills/personal.md"), "personal").unwrap();
        let next = skill_archive(&[("package/skills/pony/SKILL.md", b"---\ndescription: skill\n---\nx")], None);
        install_from_tarball("@fezchat/skill-pack", &next, "2", home.path()).unwrap();
        assert!(!home.path().join("packages/skill-pack/skills/pony/old.txt").exists());
        assert_eq!(std::fs::read_to_string(home.path().join("skills/personal.md")).unwrap(), "personal");
    }


    #[test]
    fn nested_categories_stop_at_the_first_skill_entrypoint() {
        let home = tempfile::tempdir().unwrap();
        let archive = skill_archive(&[
            ("package/skills/category/pony/SKILL.md", b"---\ndescription: real skill\n---\nx"),
            ("package/skills/category/pony/references/nested/SKILL.md", b"---\ndescription: support\n---\nx"),
            ("package/skills/category/readme.md", b"---\ndescription: not an entrypoint\n---\nx"),
            ("package/skills/category2/other/SKILL.md", b"---\ndescription: another\n---\nx"),
        ], None);
        install_from_tarball("@fezchat/skill-pack", &archive, "1", home.path()).unwrap();
        let ids: Vec<String> = installed_skills(home.path()).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["category/pony", "category2/other"]);
    }

    #[test]
    fn root_skill_entrypoint_owns_its_support_tree() {
        let home = tempfile::tempdir().unwrap();
        let archive = skill_archive(&[
            ("package/skills/SKILL.md", b"---\ndescription: root\n---\nx"),
            ("package/skills/notes.md", b"---\ndescription: support\n---\nx"),
            ("package/skills/child/SKILL.md", b"---\ndescription: support\n---\nx"),
        ], None);
        install_from_tarball("@fezchat/skill-pack", &archive, "1", home.path()).unwrap();
        let skills = installed_skills(home.path());
        assert_eq!(skills.len(), 1); assert_eq!(skills[0].id, "skills");
    }

    #[test]
    fn metadata_matches_quoted_list_and_manual_invocation_rules() {
        let (name, description, options, manual) = skill_frontmatter(
            "---\nname: ''\ndescription: |+\n  a literal\n\n  description\noptions:\n  - 'one,two'\n  - \"three\\nfour\"\ndisable-model-invocation: 'FALSE'\n---", "fallback");
        assert_eq!(name, "fallback"); assert_eq!(description, "a literal description");
        assert_eq!(options, vec!["one,two", "three\nfour"]); assert!(!manual);
        assert!(skill_frontmatter("---\ndescription: ok\ndisable-model-invocation: maybe\n---", "x").3);
    }

    #[test]
    fn ambiguous_archive_paths_are_rejected_before_replacing_old_skills() {
        for path in ["package/skills/../escape.txt", "package/skills/./pony/alias.txt", "package/skills//alias.txt"] {
            let home = tempfile::tempdir().unwrap();
            let normal = skill_archive(&[("package/skills/pony/SKILL.md", b"---\ndescription: old\n---\nx")], None);
            install_from_tarball("@fezchat/skill-pack", &normal, "1", home.path()).unwrap();
            let mut archive = tar::Builder::new(Vec::new());
            // Build a hostile raw tar name; Builder's safe append_data refuses it.
            for (name, bytes) in [("package/package.json", tar_read(&normal, "package.json").unwrap()), ("package/skills/pony/SKILL.md", b"---\ndescription: new\n---\nx".to_vec()), (path, b"bad".to_vec())] {
                let mut header = tar::Header::new_gnu();
                header.as_mut_bytes()[..100].fill(0);
                header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
                header.set_mode(0o644); header.set_size(bytes.len() as u64); header.set_cksum();
                archive.append(&header, bytes.as_slice()).unwrap();
            }
            assert!(install_from_tarball("@fezchat/skill-pack", &archive.into_inner().unwrap(), "2", home.path()).is_err(), "{path}");
            assert!(std::fs::read_to_string(home.path().join("packages/skill-pack/skills/pony/SKILL.md")).unwrap().contains("old"));
        }
    }

    #[test]
    fn a_symlink_resource_invalidates_discovery_without_reading_its_target() {
        let home = tempfile::tempdir().unwrap(); let outside = tempfile::tempdir().unwrap();
        let archive = skill_archive(&[("package/skills/pony/SKILL.md", b"---\ndescription: safe\n---\nx")], None);
        install_from_tarball("@fezchat/skill-pack", &archive, "1", home.path()).unwrap();
        std::fs::write(outside.path().join("secret.txt"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("packages/skill-pack/skills/pony/references")).unwrap();
        assert!(installed_skills(home.path()).is_empty());
        assert!(install_from_tarball("@fezchat/skill-pack", &archive, "2", home.path()).is_err());
        assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "private");
    }


    #[test]
    fn skill_support_scripts_keep_execute_bits_but_never_special_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let archive = skill_archive(&[
            ("package/skills/pony/SKILL.md", b"---\ndescription: safe\n---\nx"),
            ("package/skills/pony/scripts/run.sh", b"#!/bin/sh\nexit 97\n"),
        ], None);
        install_from_tarball("@fezchat/skill-pack", &archive, "1", home.path()).unwrap();
        let dir = home.path().join("packages/skill-pack/skills/pony");
        assert_eq!(std::fs::metadata(dir.join("scripts/run.sh")).unwrap().permissions().mode() & 0o7777, 0o755);
        assert_eq!(std::fs::metadata(dir.join("SKILL.md")).unwrap().permissions().mode() & 0o7777, 0o644);
    }


    #[test]
    fn conflicting_archive_files_are_preflighted_before_installation() {
        for files in [
            vec![("package/skills/pony/SKILL.md", b"---\ndescription: x\n---\n".as_slice()), ("package/skills/pony/SKILL.md", b"duplicate".as_slice())],
            vec![("package/skills/pony/SKILL.md", b"---\ndescription: x\n---\n".as_slice()), ("package/skills/pony", b"file ancestor".as_slice())],
        ] {
            let home = tempfile::tempdir().unwrap();
            assert!(install_from_tarball("@fezchat/skill-pack", &skill_archive(&files, None), "1", home.path()).is_err());
            assert!(!home.path().join("packages/skill-pack").exists());
        }
    }

}
