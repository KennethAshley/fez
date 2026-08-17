use std::process::Command;

/// The user's fez identity from the macOS keychain — the same key every
/// other fez surface uses (service "fez-keys"). The webview receives the
/// hex and signs in-process, exactly the TUI's custody model; the key
/// never leaves the machine.
#[tauri::command]
fn get_identity(account: Option<String>) -> Result<String, String> {
    let account = account.unwrap_or_else(|| "default".to_string());
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "fez-keys",
            "-a",
            &account,
            "-w",
        ])
        .output()
        .map_err(|e| format!("couldn't run security: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "no fez identity in the keychain for account \"{account}\" — run `fez keygen` (or `fez pair receive` on a new machine)"
        ));
    }
    let hex = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("keychain entry is not a 64-hex key".to_string());
    }
    Ok(hex)
}

/// Store a newly generated (or paired-in) identity in the keychain —
/// the onboarding writer. Refuses to overwrite: an existing identity is
/// never silently replaced from the GUI.
#[tauri::command]
fn set_identity(account: Option<String>, hex: String) -> Result<(), String> {
    let account = account.unwrap_or_else(|| "default".to_string());
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("not a 64-hex key".to_string());
    }
    if get_identity(Some(account.clone())).is_ok() {
        return Err(format!("account \"{account}\" already holds an identity"));
    }
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-s",
            "fez-keys",
            "-a",
            &account,
            "-w",
            &hex,
            "-U",
        ])
        .status()
        .map_err(|e| format!("couldn't run security: {e}"))?;
    if !status.success() {
        return Err("keychain write failed".to_string());
    }
    Ok(())
}

/// Create a persona file (~/.fez/personas/<name>.md) — the GUI's agent
/// creation. The MD file is the whole contract: herdr/sentinel spawn the
/// agent on its first @mention. Refuses overwrite; existing personas are
/// edited in an editor, not silently replaced from a dialog.
#[tauri::command]
fn write_persona(name: String, content: String) -> Result<String, String> {
    if name.len() < 2
        || name.len() > 32
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || name.starts_with('-')
    {
        return Err("name must be 2-32 chars of a-z, 0-9, - (it becomes the @mention)".to_string());
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".fez").join("personas");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{name}.md"));
    if path.exists() {
        return Err(format!("persona \"{name}\" already exists"));
    }
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(path.display().to_string())
}

fn persona_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    Ok(std::path::Path::new(&home).join(".fez").join("personas"))
}

fn valid_persona_name(name: &str) -> bool {
    name.len() >= 2
        && name.len() <= 32
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
}

/// Persona files on disk — the agents the GUI can edit, including ones
/// that have never spawned (and so have no 47000 metadata yet).
#[tauri::command]
fn list_personas() -> Result<Vec<String>, String> {
    let dir = persona_dir()?;
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn read_persona(name: String) -> Result<String, String> {
    if !valid_persona_name(&name) {
        return Err("bad persona name".to_string());
    }
    std::fs::read_to_string(persona_dir()?.join(format!("{name}.md")))
        .map_err(|e| format!("couldn't read persona \"{name}\": {e}"))
}

/// Overwrite an EXISTING persona — the editing counterpart of
/// write_persona (which refuses overwrite). Requiring existence means a
/// typo'd name can't silently create a second agent.
#[tauri::command]
fn update_persona(name: String, content: String) -> Result<(), String> {
    if !valid_persona_name(&name) {
        return Err("bad persona name".to_string());
    }
    let path = persona_dir()?.join(format!("{name}.md"));
    if !path.exists() {
        return Err(format!("persona \"{name}\" doesn't exist — use create for new agents"));
    }
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
fn delete_persona(name: String) -> Result<(), String> {
    if !valid_persona_name(&name) {
        return Err("bad persona name".to_string());
    }
    let path = persona_dir()?.join(format!("{name}.md"));
    if !path.exists() {
        return Err(format!("persona \"{name}\" doesn't exist"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("delete failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_identity, set_identity, write_persona, list_personas, read_persona, update_persona, delete_persona])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
