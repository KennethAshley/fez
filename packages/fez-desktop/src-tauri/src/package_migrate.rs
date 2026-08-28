//! Task 7: an install from before the package-dir layout has its facts
//! scattered — flat files under `gui-extensions/`, `bin/`, etc., with
//! `extensionPermissions`/`extensionBins`/`extensionVersions` in
//! settings.json and no `packages/<name>/` at all. On first run after
//! upgrade, synthesize one: mirrors `install_from_tarball`'s layout exactly
//! (reuses its `link_index`/`safe_bin_name` rather than re-deriving them),
//! so a migrated install is indistinguishable from a fresh one afterward.

use crate::package_install::{link_index, safe_bin_name};
use std::path::Path;

const PART_DIRS: [(&str, &str); 4] = [
    ("gui", "gui-extensions"),
    ("headless", "extensions"),
    ("relay", "relay-extensions"),
    ("workspace", "workspace-providers"),
];

/// For every name in `settings.extensionPermissions` with no
/// `packages/<name>/` yet, reconstruct one from the flat files + settings
/// facts an old install left behind, moving each flat file into the package
/// dir and symlinking the old flat path back to it. Never mutates
/// `settings` — the caller (lib.rs's startup hook) drops the now-redundant
/// `extensionBins`/`extensionVersions` itself once this returns `Ok`, so
/// settings-mutation stays out of this testable core.
///
/// Idempotent AND resumable. "Done" is `packages/<name>/package.json`
/// existing — not just the dir — because the dir is created before any
/// move happens; treating the bare dir as "done" would let a crash (or one
/// failed rename) mid-name leave a package.json-less dir that every future
/// run skips forever, silently losing that name's facts once the caller
/// clears `extensionBins`/`extensionVersions` on `Ok`. A half-moved name is
/// instead resumed: each per-item move first checks whether the flat path
/// is already a symlink (a prior partial run got that one done) and skips
/// re-renaming it, so a retry finishes the remaining items and writes
/// package.json. A name with no flat files at all (a settings orphan — e.g.
/// a grant left behind after a manual `rm -rf`) is skipped too, but
/// reported in the returned log rather than silently dropped.
///
/// The reconstructed manifest's `fez.permissions` is capped at exactly the
/// granted list — a reconstructed manifest must never claim MORE than what
/// was actually granted. A real `fez update` later overwrites it with the
/// package's true manifest.
pub(crate) fn migrate_flat_installs(home: &Path, settings: &serde_json::Value) -> Result<Vec<String>, String> {
    let mut log = Vec::new();
    let Some(perms_map) = settings.pointer("/extensionPermissions").and_then(|v| v.as_object()) else {
        return Ok(log);
    };
    let packages_dir = home.join("packages");

    for (name, granted) in perms_map {
        let pkg_dir = packages_dir.join(name);
        if pkg_dir.join("package.json").exists() {
            continue; // fully migrated (or a fresh install) — the manifest is the completion marker, not just the dir
        }

        let found_parts: Vec<(&str, &str)> =
            PART_DIRS.into_iter().filter(|(_, dir)| home.join(dir).join(format!("{name}.js")).exists()).collect();
        let bin_cmds: Vec<String> = settings
            .pointer(&format!("/extensionBins/{name}"))
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let found_bins: Vec<String> = bin_cmds
            .into_iter()
            .filter(|cmd| safe_bin_name(cmd) && home.join("bin").join(cmd).exists())
            .collect();

        if found_parts.is_empty() && found_bins.is_empty() {
            log.push(format!("{name}: no flat files found — settings orphan, skipped"));
            continue;
        }

        std::fs::create_dir_all(&pkg_dir).map_err(|e| e.to_string())?;

        let mut parts_json = serde_json::Map::new();
        for (part_key, dir) in &found_parts {
            let flat = home.join(dir).join(format!("{name}.js"));
            let dest = pkg_dir.join("dist").join(format!("{part_key}.js"));
            // A flat path that's already a symlink was moved by a prior
            // partial run — resume by leaving it, not by re-renaming a
            // symlink onto its own target.
            let already_moved = std::fs::symlink_metadata(&flat).map(|m| m.file_type().is_symlink()).unwrap_or(false);
            if !already_moved {
                std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::rename(&flat, &dest).map_err(|e| e.to_string())?;
                link_index(&dest, &flat)?;
                log.push(format!("{name}: {dir}/{name}.js → packages/{name}/dist/{part_key}.js (migrated)"));
            }
            parts_json.insert(part_key.to_string(), serde_json::json!(format!("dist/{part_key}.js")));
        }

        let mut bin_json = serde_json::Map::new();
        for cmd in &found_bins {
            let flat = home.join("bin").join(cmd);
            let dest = pkg_dir.join("bin").join(cmd);
            let already_moved = std::fs::symlink_metadata(&flat).map(|m| m.file_type().is_symlink()).unwrap_or(false);
            if !already_moved {
                std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::rename(&flat, &dest).map_err(|e| e.to_string())?;
                link_index(&dest, &flat)?;
                log.push(format!("{name}: bin/{cmd} → packages/{name}/bin/{cmd} (migrated)"));
            }
            bin_json.insert(cmd.clone(), serde_json::json!(format!("bin/{cmd}")));
        }

        let version = settings
            .pointer(&format!("/extensionVersions/{name}"))
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();
        let permissions: Vec<String> =
            granted.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();

        let mut manifest = serde_json::json!({
            "name": name,
            "version": version,
            "fez": {
                "type": "extension",
                "permissions": permissions,
                "parts": serde_json::Value::Object(parts_json),
                "reconstructed": true,
            },
        });
        if !bin_json.is_empty() {
            manifest["bin"] = serde_json::Value::Object(bin_json);
        }
        std::fs::write(pkg_dir.join("package.json"), serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }

    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_install_becomes_a_reconstructed_package() {
        let home = tempfile::tempdir().unwrap();
        for d in ["gui-extensions", "bin"] {
            std::fs::create_dir_all(home.path().join(d)).unwrap();
        }
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

    #[test]
    fn permissions_are_capped_at_what_was_granted_not_reinvented() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("extensions")).unwrap();
        std::fs::write(home.path().join("extensions").join("tidy.js"), "headless").unwrap();
        let settings = serde_json::json!({
            "extensionPermissions": { "tidy": ["ui"] },
        });
        migrate_flat_installs(home.path(), &settings).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.path().join("packages").join("tidy").join("package.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.pointer("/fez/permissions"), Some(&serde_json::json!(["ui"])));
        assert_eq!(manifest.pointer("/fez/parts/headless"), Some(&serde_json::json!("dist/headless.js")));
        assert_eq!(manifest.pointer("/version"), Some(&serde_json::json!("0.0.0")));
    }

    #[test]
    fn a_settings_orphan_is_skipped_but_reported() {
        let home = tempfile::tempdir().unwrap();
        let settings = serde_json::json!({
            "extensionPermissions": { "ghost": ["ui"] },
        });
        let log = migrate_flat_installs(home.path(), &settings).unwrap();
        assert!(!home.path().join("packages").join("ghost").exists());
        assert!(log.iter().any(|l| l.contains("ghost") && l.contains("orphan")));
    }

    #[test]
    fn a_partially_migrated_name_is_resumed_not_locked_out() {
        let home = tempfile::tempdir().unwrap();
        for d in ["gui-extensions", "extensions"] {
            std::fs::create_dir_all(home.path().join(d)).unwrap();
        }
        // Simulate a crash mid-migration: pkg_dir exists, one part already
        // moved + symlinked back, but package.json was never written (the
        // old "pkg_dir.exists()" marker would treat this as done forever).
        let pkg_dir = home.path().join("packages").join("tidy");
        std::fs::create_dir_all(pkg_dir.join("dist")).unwrap();
        std::fs::write(pkg_dir.join("dist").join("gui.js"), "gui").unwrap();
        std::os::unix::fs::symlink(
            pkg_dir.join("dist").join("gui.js"),
            home.path().join("gui-extensions").join("tidy.js"),
        )
        .unwrap();
        // second part still flat — the part of the move that never happened
        std::fs::write(home.path().join("extensions").join("tidy.js"), "headless").unwrap();

        let settings = serde_json::json!({
            "extensionPermissions": { "tidy": ["ui"] },
            "extensionVersions": { "tidy": "0.2.0" },
        });
        migrate_flat_installs(home.path(), &settings).unwrap();

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(pkg_dir.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest.pointer("/fez/reconstructed"), Some(&serde_json::json!(true)));
        assert_eq!(manifest.pointer("/version"), Some(&serde_json::json!("0.2.0")));
        assert_eq!(manifest.pointer("/fez/parts/gui"), Some(&serde_json::json!("dist/gui.js")));
        assert_eq!(manifest.pointer("/fez/parts/headless"), Some(&serde_json::json!("dist/headless.js")));
        assert!(pkg_dir.join("dist/headless.js").exists());
        let link = home.path().join("extensions").join("tidy.js");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }

    #[test]
    fn already_migrated_name_is_left_untouched() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("packages").join("tidy")).unwrap();
        std::fs::write(home.path().join("packages").join("tidy").join("package.json"), "{}").unwrap();
        let settings = serde_json::json!({ "extensionPermissions": { "tidy": ["ui"] } });
        let log = migrate_flat_installs(home.path(), &settings).unwrap();
        assert!(log.is_empty());
        assert_eq!(
            std::fs::read_to_string(home.path().join("packages").join("tidy").join("package.json")).unwrap(),
            "{}"
        );
    }
}
