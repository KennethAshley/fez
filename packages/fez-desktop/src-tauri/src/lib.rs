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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_identity, set_identity, write_persona])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
