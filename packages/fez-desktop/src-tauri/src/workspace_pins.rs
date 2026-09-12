use std::{fs, io::{self, Write}, path::Path, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn read(file: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Immutable file storage shared with Node. TypeScript owns relay/key validation
/// and trust decisions; this boundary only publishes complete bytes once.
pub(crate) fn pin(directory: &Path, id: &str, value: Option<&str>) -> Result<Option<String>, String> {
    if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid workspace pin id".into());
    }
    let file = directory.join(format!("{id}.pubkey"));
    let existing = read(&file).map_err(|e| e.to_string())?;
    if existing.is_some() || value.is_none() { return Ok(existing); }
    let value = value.unwrap();
    if value.is_empty() || value.len() > 4096 { return Err("invalid workspace pin value".into()); }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!("{id}.{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> io::Result<Option<String>> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        output.write_all(value.as_bytes())?;
        output.sync_all()?;
        match fs::hard_link(&temporary, &file) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        fs::File::open(directory)?.sync_all()?;
        read(&file)
    })();
    let _ = fs::remove_file(temporary);
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_complete_value_wins_and_paths_are_bounded() {
        let directory = std::env::temp_dir().join(format!("fez-pin-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let id = "a".repeat(64);
        assert_eq!(pin(&directory, &id, None).unwrap(), None);
        assert_eq!(pin(&directory, &id, Some("first")).unwrap().as_deref(), Some("first"));
        assert_eq!(pin(&directory, &id, Some("second")).unwrap().as_deref(), Some("first"));
        assert!(pin(&directory, "../outside", Some("bad")).is_err());
        fs::write(directory.join(format!("{id}.pubkey")), [0xff]).unwrap();
        assert!(pin(&directory, &id, Some("replacement")).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
