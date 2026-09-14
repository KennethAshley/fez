//! First-install seeding for the actual extension packages carried by the app.
use std::path::Path;
use std::io::Read;

pub(crate) fn install_missing(
    source: &Path,
    home: &Path,
    mut install: impl FnMut(&str, &[u8], &str) -> Result<(), String>,
) -> Result<(), String> {
    let settings: serde_json::Value = match std::fs::read(home.join("settings.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("settings.json unreadable: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(e.to_string()),
    };
    if !settings.is_object() { return Err("settings.json must contain an object".into()); }
    let mut archives = std::fs::read_dir(source).map_err(|e| format!("bundled extensions missing: {e}"))?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    archives.sort_by_key(|entry| entry.file_name());
    for entry in archives {
        if entry.path().extension().and_then(|s| s.to_str()) != Some("tgz") { continue; }
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(std::fs::File::open(entry.path()).map_err(|e| e.to_string())?)
            .take(120 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > 120 * 1024 * 1024 { return Err("bundled extension exceeds 120MB".into()); }
        let manifest: serde_json::Value = serde_json::from_slice(
            &crate::package_install::tar_read(&bytes, "package.json").ok_or("bundled extension has no package.json")?
        ).map_err(|e| e.to_string())?;
        let name = manifest["name"].as_str().ok_or("bundled extension has no name")?;
        let version = manifest["version"].as_str().ok_or("bundled extension has no version")?;
        let base = name.rsplit('/').next().unwrap_or(name).trim_start_matches('@');
        if base.is_empty() || !base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
            return Err("invalid bundled extension name".into());
        }
        let marker = home.join("bundled-extensions").join(base);
        if std::fs::symlink_metadata(&marker).is_ok() { continue; }
        // ponytail: seed once, no automatic upgrades. Track installed-file hashes
        // before adding upgrades that must preserve customized files and uninstalls.
        let present = std::fs::symlink_metadata(home.join("packages").join(base)).is_ok()
            || crate::package_install::installed_alias(name, base, home).is_some()
            || ["gui-extensions", "extensions", "relay-extensions", "workspace-providers", "miners"].iter()
                .any(|dir| std::fs::symlink_metadata(home.join(dir).join(format!("{base}.js"))).is_ok())
            || ["mcpServers", "extensionPermissions", "extensionVersions", "extensionBins"].iter()
                .any(|key| settings.get(key).and_then(|map| map.get(base)).is_some());
        if !present {
            if let Err(error) = install(name, &bytes, version) {
                // This ID was absent before our attempt. Drop only its new files
                // so a failed seed is not mistaken for a customized user install.
                let package = home.join("packages").join(base);
                if std::fs::symlink_metadata(&package).is_ok() {
                    crate::package_install::remove_installed(base, home).map(|_| ())
                        .or_else(|_| std::fs::remove_dir_all(&package).map_err(|e| e.to_string()))
                        .map_err(|cleanup| format!("{error}; seed cleanup failed: {cleanup}"))?;
                }
                return Err(error);
            }
        }
        std::fs::create_dir_all(marker.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(marker, if present { "preserved" } else { version }).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_install;
    use std::io::Write;

    fn archive(source: &Path) {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, data) in [
            ("package/package.json", r#"{"name":"@fezchat/sample","version":"1.0.0","fez":{"parts":{"gui":"dist/gui.js"}}}"#),
            ("package/dist/gui.js", "export function activate() {}"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64); header.set_mode(0o644); header.set_cksum();
            tar.append_data(&mut header, path, data.as_bytes()).unwrap();
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar.into_inner().unwrap()).unwrap();
        std::fs::write(source.join("sample.tgz"), gzip.finish().unwrap()).unwrap();
    }

    #[test]
    fn seeds_a_real_package_once_and_respects_later_uninstall() {
        let source = tempfile::tempdir().unwrap(); let home = tempfile::tempdir().unwrap();
        archive(source.path());
        install_missing(source.path(), home.path(), |name, bytes, version| {
            package_install::install_from_tarball(name, bytes, version, home.path()).map(|_| ())
        }).unwrap();
        assert_eq!(std::fs::read_to_string(home.path().join("packages/sample/dist/gui.js")).unwrap(), "export function activate() {}");
        assert!(home.path().join("bundled-extensions/sample").is_file());
        std::fs::remove_dir_all(home.path().join("packages/sample")).unwrap();
        install_missing(source.path(), home.path(), |_, _, _| panic!("must respect uninstall")).unwrap();
        assert!(!home.path().join("packages/sample").exists());
    }

    #[test]
    fn preserves_installed_linked_and_legacy_user_customizations() {
        let source = tempfile::tempdir().unwrap(); archive(source.path());
        for existing in ["packages/sample", "gui-extensions/sample.js", "extensions/sample.js"] {
            let home = tempfile::tempdir().unwrap(); let target = home.path().join(existing);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            // A dangling link still belongs to the user.
            std::os::unix::fs::symlink("missing-user-checkout", &target).unwrap();
            install_missing(source.path(), home.path(), |_, _, _| panic!("must preserve user link")).unwrap();
            assert_eq!(std::fs::read_link(target).unwrap(), std::path::PathBuf::from("missing-user-checkout"));
        }
        let home = tempfile::tempdir().unwrap();
        let settings = r#"{"mcpServers":{"sample":{"command":"custom"}}}"#;
        std::fs::write(home.path().join("settings.json"), settings).unwrap();
        install_missing(source.path(), home.path(), |_, _, _| panic!("must preserve skill configuration")).unwrap();
        assert_eq!(std::fs::read_to_string(home.path().join("settings.json")).unwrap(), settings);
    }

    #[test]
    fn preserves_the_same_package_installed_under_a_legacy_id() {
        let source = tempfile::tempdir().unwrap(); let home = tempfile::tempdir().unwrap(); archive(source.path());
        let legacy = home.path().join("packages/fez-sample");
        std::fs::create_dir_all(&legacy).unwrap();
        let manifest = r#"{"name":"@fezchat/sample","version":"0.9.0"}"#;
        std::fs::write(legacy.join("package.json"), manifest).unwrap();
        std::fs::write(legacy.join("custom.txt"), "keep my data").unwrap();
        install_missing(source.path(), home.path(), |name, bytes, version| {
            package_install::install_from_tarball(name, bytes, version, home.path()).map(|_| ())
        }).unwrap();
        assert!(!home.path().join("packages/sample").exists());
        assert_eq!(std::fs::read_to_string(legacy.join("package.json")).unwrap(), manifest);
        assert_eq!(std::fs::read_to_string(legacy.join("custom.txt")).unwrap(), "keep my data");
        assert_eq!(std::fs::read_to_string(home.path().join("bundled-extensions/sample")).unwrap(), "preserved");
    }

    #[test]
    fn failed_install_has_no_success_receipt_and_bad_settings_are_not_overwritten() {
        let source = tempfile::tempdir().unwrap(); let home = tempfile::tempdir().unwrap(); archive(source.path());
        assert!(install_missing(source.path(), home.path(), |name, bytes, version| {
            package_install::install_from_tarball(name, bytes, version, home.path())?;
            Err("settings write failed".into())
        }).is_err());
        assert!(!home.path().join("bundled-extensions/sample").exists());
        assert!(!home.path().join("packages/sample").exists(), "partial seed must remain retryable");
        std::fs::write(home.path().join("settings.json"), "not JSON").unwrap();
        assert!(install_missing(source.path(), home.path(), |_, _, _| panic!("must not install with unreadable settings")).is_err());
        assert_eq!(std::fs::read_to_string(home.path().join("settings.json")).unwrap(), "not JSON");
    }
}
