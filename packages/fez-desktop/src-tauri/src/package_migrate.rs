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
/// Idempotent: a name whose `packages/<name>/` already exists (a prior
/// migration, or a fresh install) is skipped outright — a second run
/// changes nothing. A name with no flat files at all (a settings orphan —
/// e.g. a grant left behind after a manual `rm -rf`) is skipped too, but
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
        if pkg_dir.exists() {
            continue; // already migrated, or never flat to begin with
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
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::rename(&flat, &dest).map_err(|e| e.to_string())?;
            link_index(&dest, &flat)?;
            parts_json.insert(part_key.to_string(), serde_json::json!(format!("dist/{part_key}.js")));
            log.push(format!("{name}: {dir}/{name}.js → packages/{name}/dist/{part_key}.js (migrated)"));
        }

        let mut bin_json = serde_json::Map::new();
        for cmd in &found_bins {
            let flat = home.join("bin").join(cmd);
            let dest = pkg_dir.join("bin").join(cmd);
            std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::rename(&flat, &dest).map_err(|e| e.to_string())?;
            link_index(&dest, &flat)?;
            bin_json.insert(cmd.clone(), serde_json::json!(format!("bin/{cmd}")));
            log.push(format!("{name}: bin/{cmd} → packages/{name}/bin/{cmd} (migrated)"));
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
