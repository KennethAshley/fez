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

/// Rename a persona file. The agent's identity key derives from the
/// persona name, so a rename means a NEW identity on next spawn — the
/// GUI warns; this command just refuses collisions.
#[tauri::command]
fn rename_persona(from: String, to: String) -> Result<(), String> {
    if !valid_persona_name(&from) || !valid_persona_name(&to) {
        return Err("bad persona name".to_string());
    }
    let dir = persona_dir()?;
    let src = dir.join(format!("{from}.md"));
    let dst = dir.join(format!("{to}.md"));
    if !src.exists() {
        return Err(format!("persona \"{from}\" doesn't exist"));
    }
    if dst.exists() {
        return Err(format!("persona \"{to}\" already exists"));
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("rename failed: {e}"))
}

/// GUI extension parts installed by `fez install`/`fez link`
/// (~/.fez/gui-extensions/*.js). The webview imports each as an ES
/// module and calls its activate(api) — the GUI's version of the TUI's
/// extension loader.
#[tauri::command]
fn list_gui_extensions() -> Result<Vec<(String, String)>, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".fez").join("gui-extensions");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("js") {
                if let (Some(stem), Ok(code)) = (
                    path.file_stem().and_then(|s| s.to_str()),
                    std::fs::read_to_string(&path),
                ) {
                    out.push((stem.to_string(), code));
                }
            }
        }
    }
    Ok(out)
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

fn drafts_dir() -> Result<std::path::PathBuf, String> {
    Ok(persona_dir()?.join("drafts"))
}

/// Agent-proposed personas awaiting the owner's review (core owns the
/// lifecycle — `fez persona draft/approve/reject`; this is the GUI's
/// window onto the same files).
#[tauri::command]
fn list_persona_drafts() -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(drafts_dir()?) {
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
fn read_persona_draft(name: String) -> Result<String, String> {
    if !valid_persona_name(&name) {
        return Err("bad draft name".to_string());
    }
    std::fs::read_to_string(drafts_dir()?.join(format!("{name}.md")))
        .map_err(|e| format!("couldn't read draft \"{name}\": {e}"))
}

/// Approve: strip draft-meta, install if the name is free. Lighter
/// validation than the CLI (harness line present) — the CLI remains the
/// thorough path; this covers the common approve-what-I-just-read case.
#[tauri::command]
fn approve_persona_draft(name: String) -> Result<(), String> {
    if !valid_persona_name(&name) {
        return Err("bad draft name".to_string());
    }
    let raw = std::fs::read_to_string(drafts_dir()?.join(format!("{name}.md")))
        .map_err(|e| format!("couldn't read draft: {e}"))?;
    let cleaned: String = raw
        .lines()
        .filter(|line| !line.starts_with("proposedBy:") && !line.starts_with("proposedAt:"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    if !cleaned.lines().any(|l| l.starts_with("harness:")) {
        return Err("draft has no harness: line — fix it (or use fez persona approve for full validation)".to_string());
    }
    let target = persona_dir()?.join(format!("{name}.md"));
    if target.exists() {
        return Err(format!("a live persona named \"{name}\" already exists"));
    }
    std::fs::write(&target, cleaned).map_err(|e| format!("install failed: {e}"))?;
    std::fs::remove_file(drafts_dir()?.join(format!("{name}.md"))).map_err(|e| format!("cleanup failed: {e}"))
}

/// Marketplace install path: a downloaded persona lands as a DRAFT for
/// review — same refusals as the CLI (no shadowing live personas, no
/// clobbering pending drafts).
#[tauri::command]
fn write_persona_draft(name: String, content: String) -> Result<(), String> {
    if !valid_persona_name(&name) {
        return Err("bad persona name".to_string());
    }
    if persona_dir()?.join(format!("{name}.md")).exists() {
        return Err(format!("a live persona named \"{name}\" already exists"));
    }
    let dir = drafts_dir()?;
    let path = dir.join(format!("{name}.md"));
    if path.exists() {
        return Err(format!("a draft named \"{name}\" is already awaiting review"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
fn reject_persona_draft(name: String) -> Result<(), String> {
    if !valid_persona_name(&name) {
        return Err("bad draft name".to_string());
    }
    std::fs::remove_file(drafts_dir()?.join(format!("{name}.md"))).map_err(|e| format!("delete failed: {e}"))
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    Ok(std::path::Path::new(&home).join(".fez").join("settings.json"))
}

/// The machine's skill catalog (settings.json mcpServers) — same file
/// the CLI's `fez skill add/remove` writes; the GUI is another surface.
#[tauri::command]
fn read_skills() -> Result<String, String> {
    let raw = std::fs::read_to_string(settings_path()?).unwrap_or_else(|_| "{}".to_string());
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("settings.json unreadable: {e}"))?;
    Ok(value.get("mcpServers").cloned().unwrap_or(serde_json::json!({})).to_string())
}

#[tauri::command]
fn write_skill(name: String, config_json: String) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("bad skill name".to_string());
    }
    let config: serde_json::Value = serde_json::from_str(&config_json).map_err(|e| format!("bad config: {e}"))?;
    let path = settings_path()?;
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut settings: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("settings.json unreadable: {e}"))?;
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let servers = settings
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert(serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers.as_object_mut().unwrap().insert(name, config);
    std::fs::write(&path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n")
        .map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
fn remove_skill(name: String) -> Result<(), String> {
    let path = settings_path()?;
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut settings: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("settings.json unreadable: {e}"))?;
    if let Some(servers) = settings.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        servers.remove(&name);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n")
        .map_err(|e| format!("write failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_identity, set_identity, write_persona, list_personas, read_persona, update_persona, rename_persona, delete_persona, list_gui_extensions, list_persona_drafts, read_persona_draft, approve_persona_draft, reject_persona_draft, write_persona_draft, read_skills, write_skill, remove_skill])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
