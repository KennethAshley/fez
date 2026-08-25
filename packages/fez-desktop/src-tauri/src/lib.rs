use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Staged artifact documents, served over the `artifact://` custom
/// protocol. Artifacts used to render as `srcDoc` iframes, but srcdoc
/// documents INHERIT the parent page's CSP — so any real app CSP would
/// blank every artifact and live tool. Served from their own scheme
/// they are their own origin with their own (permissive) policy, while
/// the iframe's sandbox attribute keeps doing the actual containment.
/// BTreeMap because ids ascend: the first key is always the oldest,
/// which makes the size cap a one-liner.
static ARTIFACT_DOCS: Mutex<Option<std::collections::BTreeMap<u64, String>>> = Mutex::new(None);
static ARTIFACT_NEXT: AtomicU64 = AtomicU64::new(1);
/// More staged docs than this and the oldest fall off — a leaked stage
/// (webview reloaded mid-flight) must not grow the map forever.
const ARTIFACT_CAP: usize = 64;

/// Park an artifact document; the webview turns the id into an
/// artifact:// URL (convertFileSrc) and points the iframe's src at it.
#[tauri::command]
fn stage_artifact(html: String) -> u64 {
    let id = ARTIFACT_NEXT.fetch_add(1, Ordering::Relaxed);
    let mut guard = ARTIFACT_DOCS.lock().unwrap_or_else(|p| p.into_inner());
    let docs = guard.get_or_insert_with(Default::default);
    docs.insert(id, html);
    while docs.len() > ARTIFACT_CAP {
        let oldest = *docs.keys().next().unwrap();
        docs.remove(&oldest);
    }
    id
}

/// The unmount half — a rendered artifact releases its doc.
#[tauri::command]
fn release_artifact(id: u64) {
    let mut guard = ARTIFACT_DOCS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(docs) = guard.as_mut() {
        docs.remove(&id);
    }
}

fn artifact_doc(id: u64) -> Option<String> {
    let guard = ARTIFACT_DOCS.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_ref().and_then(|docs| docs.get(&id).cloned())
}

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
        // Two very different failures share a non-zero exit, and the app
        // routes on which one it was: "no such item" is a FRESH MACHINE
        // (the frontend matches "no fez identity" and shows onboarding),
        // while a denied prompt / locked keychain is an access failure
        // that must NOT create a second identity — it gets a retry
        // screen instead. `security` exits 44 (errSecItemNotFound) when
        // the item is absent; the stderr match is the belt to that
        // suspender.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let not_found = output.status.code() == Some(44) || stderr.contains("could not be found");
        if not_found {
            return Err(format!("no fez identity in the keychain for account \"{account}\""));
        }
        return Err(format!(
            "keychain access failed for account \"{account}\": {}",
            stderr.trim()
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

fn valid_secret_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Store a skill's secret env value in the macOS keychain (service
/// "fez-skill-env", account "<skill>.<KEY>") — same custody as the
/// identity. WRITE-ONLY from the GUI: there is deliberately no command
/// that returns a secret to the webview; agents resolve values at spawn
/// via the same `security` read in core.
#[tauri::command]
fn set_skill_secret(skill: String, key: String, value: String) -> Result<(), String> {
    if !valid_secret_name(&skill) || !valid_secret_name(&key) {
        return Err("bad skill/key name".to_string());
    }
    if value.is_empty() {
        return Err("empty value — use the keychain app to delete entries".to_string());
    }
    let account = format!("{skill}.{key}");
    let status = Command::new("security")
        .args(["add-generic-password", "-U", "-s", "fez-skill-env", "-a", &account, "-w", &value])
        .status()
        .map_err(|e| format!("couldn't run security: {e}"))?;
    if !status.success() {
        return Err("keychain write failed".to_string());
    }
    Ok(())
}

/// Whether a secret exists (never its value).
#[tauri::command]
fn has_skill_secret(skill: String, key: String) -> Result<bool, String> {
    if !valid_secret_name(&skill) || !valid_secret_name(&key) {
        return Err("bad skill/key name".to_string());
    }
    let account = format!("{skill}.{key}");
    let output = Command::new("security")
        .args(["find-generic-password", "-s", "fez-skill-env", "-a", &account])
        .output()
        .map_err(|e| format!("couldn't run security: {e}"))?;
    Ok(output.status.success())
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

/// What each installed extension was granted (settings.extensionPermissions).
/// The GUI narrows its api per extension from this — same grants the CLI
/// recorded at install time, so both hosts enforce one decision.
#[tauri::command]
fn read_extension_grants() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let path = std::path::Path::new(&home).join(".fez").join("settings.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    Ok(parsed
        .get("extensionPermissions")
        .cloned()
        .unwrap_or(serde_json::json!({}))
        .to_string())
}

/// The `.fez` home directory, created if missing.
fn fez_home() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    Ok(std::path::Path::new(&home).join(".fez"))
}

/// Read ~/.fez/settings.json (or {}), apply `f`, write it back.
fn update_settings(f: impl FnOnce(&mut serde_json::Value)) -> Result<(), String> {
    let path = fez_home()?.join("settings.json");
    let mut json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !json.is_object() {
        json = serde_json::json!({});
    }
    f(&mut json);
    std::fs::create_dir_all(fez_home()?).map_err(|e| e.to_string())?;
    // Propagate a serialize failure — the old unwrap_or_default() wrote an
    // EMPTY STRING over settings.json, losing every skill and grant.
    let text = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("couldn't write settings.json: {e}"))
}

/// A settings.json member as a mutable object, resetting a wrong-typed
/// value in place — a hand-edited (or other-version) file must never
/// panic an install. The unwrap after the reset cannot fail.
fn obj_entry<'a>(
    obj: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    let v = obj.entry(key.to_string()).or_insert_with(|| serde_json::json!({}));
    if !v.is_object() {
        *v = serde_json::json!({});
    }
    v.as_object_mut().unwrap()
}

/// Read one file out of an in-memory npm tarball. Entries are prefixed
/// with "package/"; `rel` is the path within the package ("package.json",
/// "dist/gui.js").
fn tar_read(tar_bytes: &[u8], rel: &str) -> Option<Vec<u8>> {
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
fn tar_list_md(tar_bytes: &[u8], dir: &str) -> Vec<(String, String)> {
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

/// Which agent harnesses are actually installed — the ACP bridges each one
/// speaks through (claude-code → claude-agent-acp, pi → pi-acp). A GUI app
/// gets a stripped PATH, so we look in the real install dirs (homebrew,
/// /usr/local, every nvm node version, plus whatever PATH we do have)
/// rather than trusting `which`. Returns {"claude-code": bool, "pi": bool}
/// so the UI can show what's ready and what needs installing.
fn harness_installed(cmd: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = vec![
        // fez's own bundled binaries first — the Built-in agent (pi/pi-acp)
        // ships here, so a machine with nothing on PATH still detects it.
        format!("{home}/.fez/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        format!("{home}/.local/bin"),
        // The other node-adjacent installers people actually use — a user
        // who got claude-agent-acp through bun/volta/deno/asdf/pnpm saw
        // "not installed" despite having it.
        format!("{home}/.bun/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.deno/bin"),
        format!("{home}/.asdf/shims"),
        format!("{home}/Library/pnpm"),
    ];
    if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
        dirs.push(pnpm_home);
    }
    // nvm installs globals per node version: ~/.nvm/versions/node/*/bin
    if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        for e in entries.flatten() {
            dirs.push(e.path().join("bin").to_string_lossy().to_string());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(path.split(':').map(String::from));
    }
    // Executable, not merely present — a copy that landed without its exec
    // bit (or a directory of the same name) must not report as installed.
    dirs.iter().any(|d| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(std::path::Path::new(d).join(cmd))
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

#[tauri::command]
fn detect_harnesses() -> Result<String, String> {
    let map = serde_json::json!({
        "claude-code": harness_installed("claude-agent-acp"),
        "pi": harness_installed("pi-acp"),
    });
    Ok(map.to_string())
}

/// Wire Chutes into pi as a provider and return the models — the backend
/// for the agent editor's "runs on: Chutes" option. Reads the Chutes key
/// from the keychain (set in Settings → secrets), registers the endpoint
/// in ~/.pi/agent/local-models.json (pi's local-models extension turns it
/// into provider `local-56105ece7a`), and returns {provider, models}. The
/// editor sets the persona's provider/model itself, so this creates no
/// persona. Provider id is sha256("https://llm.chutes.ai/v1")[:10], fixed
/// because the base url is fixed.
#[tauri::command]
fn wire_chutes_pi() -> Result<String, String> {
    const BASE_URL: &str = "https://llm.chutes.ai/v1";
    const PROVIDER: &str = "local-56105ece7a";
    const ID: &str = "56105ece7a";
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;

    let key = Command::new("security")
        .args(["find-generic-password", "-s", "fez-skill-env", "-a", "chutes.CHUTES_API_KEY", "-w"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "Set the Chutes key first: Settings → secrets → chutes → CHUTES_API_KEY.".to_string())?;

    let cfg = std::path::Path::new(&home).join(".pi").join("agent").join("local-models.json");
    // This file belongs to pi, not fez — a malformed or unexpected shape
    // is a reason to STOP, not to overwrite it with just our entry
    // (the old unwrap_or_default() silently destroyed every other local
    // model endpoint the user had configured).
    let mut endpoints: Vec<serde_json::Value> = match std::fs::read_to_string(&cfg) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| {
            format!("~/.pi/agent/local-models.json exists but isn't the JSON array pi expects — fix or remove it, then retry ({e})")
        })?,
        Err(_) => Vec::new(),
    };
    endpoints.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(ID));
    endpoints.push(serde_json::json!({ "id": ID, "name": "Chutes", "baseUrl": BASE_URL, "apiKey": key, "status": "checking" }));
    if let Some(parent) = cfg.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&endpoints).map_err(|e| e.to_string())?;
    std::fs::write(&cfg, text + "\n")
        .map_err(|e| format!("couldn't write pi local-models.json: {e}"))?;

    let models_body = ureq::get(&format!("{BASE_URL}/models"))
        .set("authorization", &format!("Bearer {key}"))
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("Chutes wired, but couldn't list models: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&models_body).map_err(|e| e.to_string())?;
    let models: Vec<String> = parsed
        .pointer("/data")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    if models.is_empty() {
        return Err("Chutes returned no models".to_string());
    }
    Ok(serde_json::json!({ "provider": PROVIDER, "models": models }).to_string())
}

/// Export a kept tool as a real, publishable @fezchat extension: write a
/// self-contained package (package.json + dist/gui.js + README) to
/// ~/fez-tools/<slug>. The gui part is plain JS that uses api.React and
/// api.client.runQuery, so there's nothing to build — publish it, and the
/// desktop's normal install flow places it (and grants its permissions).
/// Returns the package directory.
#[tauri::command]
fn export_tool(slug: String, gui_js: String, pkg_json: String, readme: String) -> Result<String, String> {
    if slug.is_empty() || slug.len() > 64 || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad tool slug".to_string());
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let pkg_dir = std::path::Path::new(&home).join("fez-tools").join(&slug);
    let dist = pkg_dir.join("dist");
    std::fs::create_dir_all(&dist).map_err(|e| format!("mkdir failed: {e}"))?;
    std::fs::write(pkg_dir.join("package.json"), &pkg_json).map_err(|e| e.to_string())?;
    std::fs::write(pkg_dir.join("README.md"), &readme).map_err(|e| e.to_string())?;
    std::fs::write(dist.join("gui.js"), &gui_js).map_err(|e| e.to_string())?;
    Ok(pkg_dir.to_string_lossy().to_string())
}

/// Install a fez extension WITHOUT any CLI: resolve the npm tarball,
/// download it, gunzip + untar in memory, and copy the fez.parts into
/// ~/.fez. Our gui/headless parts are self-contained esbuild bundles, so
/// there are no npm dependencies to resolve — a plain copy is the install.
#[tauri::command]
fn install_package(name: String) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '.' | '_'))
    {
        return Err("not a valid package name".to_string());
    }

    // 1. Resolve the tarball URL from the registry (latest dist-tag).
    let meta_url = format!("https://registry.npmjs.org/{}", name.replace('/', "%2f"));
    let meta_str = ureq::get(&meta_url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("couldn't reach npm for {name}: {e}"))?
        .into_string()
        .map_err(|e| format!("bad registry response: {e}"))?;
    let meta: serde_json::Value =
        serde_json::from_str(&meta_str).map_err(|e| format!("bad registry json: {e}"))?;
    let latest = meta
        .pointer("/dist-tags/latest")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{name} has no published version"))?;
    let tarball = meta
        .pointer(&format!("/versions/{latest}/dist/tarball"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no tarball for {name}@{latest}"))?
        .to_string();
    // The URL comes from the registry response — never follow it off TLS.
    if !tarball.starts_with("https://") {
        return Err(format!("refusing non-https tarball url for {name}: {tarball}"));
    }

    // 2. Download and unpack (gzip → tar) into a Vec we can read twice.
    // Extension parts are self-contained esbuild bundles — tens of KB, a
    // few MB with assets — so the caps are generous, not tight; their job
    // is bounding a hostile or broken response, not sizing real packages.
    const MAX_TGZ: u64 = 30 * 1024 * 1024;
    const MAX_TAR: u64 = 120 * 1024 * 1024;
    let mut gz = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(
            ureq::get(&tarball)
                .timeout(std::time::Duration::from_secs(120))
                .call()
                .map_err(|e| format!("download failed: {e}"))?
                .into_reader(),
            MAX_TGZ + 1,
        ),
        &mut gz,
    )
    .map_err(|e| format!("download read failed: {e}"))?;
    if gz.len() as u64 > MAX_TGZ {
        return Err(format!("{name} tarball exceeds {}MB — refusing", MAX_TGZ / (1024 * 1024)));
    }
    let mut tar_bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(flate2::read::GzDecoder::new(&gz[..]), MAX_TAR + 1),
        &mut tar_bytes,
    )
    .map_err(|e| format!("gunzip failed: {e}"))?;
    if tar_bytes.len() as u64 > MAX_TAR {
        return Err(format!("{name} expands past {}MB — refusing", MAX_TAR / (1024 * 1024)));
    }

    // 3. Read package.json (npm tarballs prefix every path with "package/").
    let pkg_bytes = tar_read(&tar_bytes, "package.json").ok_or("no package.json in tarball")?;
    let pkg: serde_json::Value =
        serde_json::from_slice(&pkg_bytes).map_err(|e| format!("bad package.json: {e}"))?;

    // 4. De-scoped basename is the file/extension name: @fezchat/kanban → kanban.
    let base = name.rsplit('/').next().unwrap_or(&name).trim_start_matches('@');
    let parts = pkg.pointer("/fez/parts");
    let home = fez_home()?;
    let mut installed: Vec<String> = Vec::new();

    // 5. Copy each code part to its directory (mirrors the CLI's installParts).
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
        let bytes =
            tar_read(&tar_bytes, rel).ok_or_else(|| format!("{part_key} part {rel} missing from tarball"))?;
        let dest_dir = home.join(dir);
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        std::fs::write(dest_dir.join(format!("{base}.js")), bytes).map_err(|e| e.to_string())?;
        installed.push(format!("{part_key} → ~/.fez/{dir}/{base}.js"));
    }

    // 5b. Skill part → an MCP server in settings.json. A relative .js entry
    // is copied out of the tarball and made absolute; a bare command (e.g.
    // `npx <public-server>`) passes through. A skill whose args point at an
    // absolute path we didn't write is left as-is (a pre-fix publish) — it
    // won't resolve, but we don't guess.
    let mut skill_entry: Option<serde_json::Value> = None;
    if let Some(skill) = parts.and_then(|p| p.get("skill")) {
        let mut entry = skill.clone();
        if let Some(args) = skill.get("args").and_then(|v| v.as_array()) {
            let mut new_args: Vec<serde_json::Value> = Vec::new();
            for a in args {
                if let Some(s) = a.as_str() {
                    if s.ends_with(".js") && !s.starts_with('/') {
                        if let Some(bytes) = tar_read(&tar_bytes, s) {
                            let skill_dir = home.join("skills").join(base);
                            let _ = std::fs::create_dir_all(&skill_dir);
                            let fname = std::path::Path::new(s)
                                .file_name()
                                .and_then(|f| f.to_str())
                                .unwrap_or("mcp.js");
                            let dest = skill_dir.join(fname);
                            if std::fs::write(&dest, bytes).is_ok() {
                                new_args.push(serde_json::json!(dest.to_string_lossy()));
                                continue;
                            }
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

    // 6. Record granted permissions + background opt-in in settings.json.
    let perms: Vec<String> = pkg
        .pointer("/fez/permissions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let wants_background = parts
        .and_then(|p| p.get("background"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let base_owned = base.to_string();
    let version = latest.to_string();
    update_settings(move |json| {
        // update_settings guarantees an object; the members do NOT come
        // with that guarantee (hand-edited files) — obj_entry resets a
        // wrong-typed value instead of panicking mid-install.
        let obj = json.as_object_mut().unwrap();
        if let Some(entry) = skill_entry {
            obj_entry(obj, "mcpServers").insert(base_owned.clone(), entry);
        }
        obj_entry(obj, "extensionPermissions").insert(base_owned.clone(), serde_json::json!(perms));
        // Record the version so the gallery can offer updates later.
        obj_entry(obj, "extensionVersions").insert(base_owned.clone(), serde_json::json!(version));
        if wants_background {
            let list = obj
                .entry("backgroundExtensions")
                .or_insert_with(|| serde_json::json!([]));
            if !list.is_array() {
                *list = serde_json::json!([]);
            }
            let list = list.as_array_mut().unwrap();
            if !list.iter().any(|v| v.as_str() == Some(base_owned.as_str())) {
                list.push(serde_json::json!(base_owned));
            }
        }
    })?;

    // 7. Persona pack — mirror the CLI's installPersonaPack: copy each
    // <dir>/*.md into ~/.fez/personas so an extension can ship its agents
    // (an @loom, @scout, @chip) the same way it ships skills. Skip a
    // persona that already exists (never clobber one the user may have
    // edited); a minimal `harness:` check keeps a broken file out. Owner
    // isn't stamped — the sentinel resolves it from the workspace.
    if pkg.pointer("/fez/personas").is_some() {
        let dir = pkg
            .pointer("/fez/personas/dir")
            .and_then(|v| v.as_str())
            .unwrap_or("personas");
        let personas_dir = home.join("personas");
        std::fs::create_dir_all(&personas_dir).ok();
        for (id, content) in tar_list_md(&tar_bytes, dir) {
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

    if installed.is_empty() {
        return Err(format!(
            "{name}@{latest} has no installable gui/headless/relay/workspace/persona part"
        ));
    }
    Ok(format!("installed {name}@{latest}: {}", installed.join(", ")))
}

/// The recorded installed version per extension (settings.json), as JSON.
#[tauri::command]
fn read_extension_versions() -> Result<String, String> {
    let path = fez_home()?.join("settings.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    Ok(parsed
        .get("extensionVersions")
        .cloned()
        .unwrap_or(serde_json::json!({}))
        .to_string())
}

/// Registry detail for an extension's page — version, description, README.
#[tauri::command]
fn package_info(name: String) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 128
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '.' | '_'))
    {
        return Err("not a valid package name".to_string());
    }
    let url = format!("https://registry.npmjs.org/{}", name.replace('/', "%2f"));
    let body = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("couldn't reach npm: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let latest = meta.pointer("/dist-tags/latest").and_then(|v| v.as_str()).unwrap_or("");
    let ver = meta.pointer(&format!("/versions/{latest}"));
    let info = serde_json::json!({
        "version": latest,
        "description": ver.and_then(|v| v.get("description")).cloned().unwrap_or(serde_json::Value::Null),
        // npm keeps the README at the packument top level, from the latest publish.
        "readme": meta.get("readme").cloned().unwrap_or(serde_json::Value::Null),
    });
    Ok(info.to_string())
}

/// The latest published version of a package, from the npm registry.
#[tauri::command]
fn latest_version(name: String) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 128
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '.' | '_'))
    {
        return Err("not a valid package name".to_string());
    }
    let url = format!("https://registry.npmjs.org/{}", name.replace('/', "%2f"));
    let body = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("couldn't reach npm: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    meta.pointer("/dist-tags/latest")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("{name} has no published version"))
}

/// Which installed agents still depend on what an uninstall just removed.
/// A persona is a plain .md with frontmatter; `repo:` needs a workspace
/// provider, `mcpServers: [..]` names skills. Returned as human lines so
/// the uninstall can WARN before a capability silently vanishes from an
/// agent's next turn — the counterpart to the runtime's degrade-and-
/// disclose (a dependent agent won't crash, but it will lose the power).
fn dependent_agents(home: &std::path::Path, workspace_removed: bool, skills: &[String]) -> Vec<String> {
    let dir = home.join("personas");
    let mut out: Vec<String> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let agent = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        // Frontmatter only: everything before the closing `---`.
        let front = content.split("\n---").next().unwrap_or(&content);
        let mut reasons: Vec<String> = Vec::new();
        for line in front.lines() {
            let t = line.trim();
            if workspace_removed && t.starts_with("repo:") {
                reasons.push("loses repo access".to_string());
            }
            if let Some(rest) = t.strip_prefix("mcpServers:") {
                let list = rest.trim().trim_start_matches('[').trim_end_matches(']');
                let items: Vec<&str> = list.split(',').map(|s| s.trim()).collect();
                for skill in skills {
                    if items.iter().any(|it| it == skill) {
                        reasons.push(format!("loses skill: {skill}"));
                    }
                }
            }
        }
        if !reasons.is_empty() {
            reasons.dedup();
            out.push(format!("@{agent} ({})", reasons.join(", ")));
        }
    }
    out
}

/// Uninstall an extension: delete its part files from every ~/.fez dir and
/// drop it from settings.json. `name` is the de-scoped base (git, kanban) —
/// tolerate a `fez-` prefix so a `fez link`-era file (fez-git.js) also goes.
#[tauri::command]
fn remove_extension(name: String) -> Result<String, String> {
    if name.is_empty() || name.len() > 128 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err("not a valid extension name".to_string());
    }
    let home = fez_home()?;
    let candidates = [name.clone(), format!("fez-{name}"), name.trim_start_matches("fez-").to_string()];
    let mut removed: Vec<String> = Vec::new();
    for dir in ["gui-extensions", "extensions", "relay-extensions", "workspace-providers"] {
        for cand in &candidates {
            let file = home.join(dir).join(format!("{cand}.js"));
            if file.exists() && std::fs::remove_file(&file).is_ok() {
                removed.push(format!("{dir}/{cand}.js"));
            }
        }
    }
    // The skill part lives in its own dir, and a matching mcpServers entry.
    for cand in &candidates {
        let skill_dir = home.join("skills").join(cand);
        if skill_dir.exists() && std::fs::remove_dir_all(&skill_dir).is_ok() {
            removed.push(format!("skills/{cand}"));
        }
    }
    // Drop the recorded permission grant + background opt-in.
    update_settings(|json| {
        if let Some(obj) = json.as_object_mut() {
            for cand in [name.as_str(), name.trim_start_matches("fez-")] {
                if let Some(perms) = obj.get_mut("extensionPermissions").and_then(|v| v.as_object_mut()) {
                    perms.remove(cand);
                }
                if let Some(bg) = obj.get_mut("backgroundExtensions").and_then(|v| v.as_array_mut()) {
                    bg.retain(|v| v.as_str() != Some(cand));
                }
                if let Some(vers) = obj.get_mut("extensionVersions").and_then(|v| v.as_object_mut()) {
                    vers.remove(cand);
                }
                if let Some(mcp) = obj.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
                    mcp.remove(cand);
                }
            }
        }
    })?;
    if removed.is_empty() {
        return Err(format!("nothing installed named \"{name}\""));
    }
    // Warn about agents that still depend on what we just pulled — they
    // won't crash (the runtime degrades + discloses), but their next spawn
    // loses the capability, and silent loss is how a stale `repo:` turned
    // into a spawn flood. workspace-providers/* backs `repo:`; skills back
    // `mcpServers:`.
    let workspace_removed = removed.iter().any(|r| r.starts_with("workspace-providers/"));
    let deps = dependent_agents(&home, workspace_removed, &candidates);
    let mut msg = format!("removed {}", removed.join(", "));
    if !deps.is_empty() {
        msg.push_str(&format!(
            "\n\n⚠️ {} agent(s) depend on this — they'll keep running but lose the capability on next spawn:\n  {}\n(edit or remove them if they no longer need it)",
            deps.len(),
            deps.join("\n  ")
        ));
    }
    Ok(msg)
}

#[tauri::command]
fn read_keymap() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let path = std::path::Path::new(&home).join(".fez").join("keymap.json");
    // Absent file is the common case — the app falls back to defaults.
    Ok(std::fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string()))
}

#[tauri::command]
fn write_keymap(json: String) -> Result<(), String> {
    // Refuse to persist anything the loader would reject and silently fall
    // back from: it must parse as a JSON object of action → binding.
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("keymap must be a JSON object of action → binding".to_string());
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".fez");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    std::fs::write(dir.join("keymap.json"), json).map_err(|e| format!("write failed: {e}"))
}

/// Extension parts on disk, by package name: headless (~/.fez/extensions)
/// and gui (~/.fez/gui-extensions). Skill parts live in settings.json and
/// are listed separately — a package can have any mix of the three.
#[tauri::command]
fn list_local_extensions() -> Result<Vec<(String, Vec<String>)>, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let mut map: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for (dir, part) in [("extensions", "headless"), ("gui-extensions", "gui")] {
        let path = std::path::Path::new(&home).join(".fez").join(dir);
        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("js") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        map.entry(stem.to_string()).or_default().push(part.to_string());
                    }
                }
            }
        }
    }
    Ok(map.into_iter().collect())
}


fn bench_ledger_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    Ok(std::path::Path::new(&home).join(".fez").join("bench").join("proposals.jsonl"))
}

/// The fez-bench proposal ledger (append-only JSONL) — raw lines; the
/// webview folds proposals + decisions.
#[tauri::command]
fn read_bench_proposals() -> Result<String, String> {
    Ok(std::fs::read_to_string(bench_ledger_path()?).unwrap_or_default())
}

/// Record an approve/deny decision. Approving a description proposal
/// also APPLIES it to the persona file — same behavior as the CLI.
#[tauri::command]
fn decide_bench_proposal(id: String, approve: bool) -> Result<(), String> {
    let path = bench_ledger_path()?;
    let raw = std::fs::read_to_string(&path).map_err(|_| "no proposal ledger".to_string())?;
    let mut target: Option<serde_json::Value> = None;
    let mut decided = false;
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let entry: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if entry["id"].as_str() == Some(id.as_str()) {
            match entry["type"].as_str() {
                Some("proposal") => target = Some(entry),
                Some("decision") => decided = true,
                _ => {}
            }
        }
    }
    let proposal = target.ok_or(format!("no proposal {id}"))?;
    if decided {
        return Err(format!("proposal {id} already decided"));
    }
    if approve && proposal["kind"].as_str() == Some("description") {
        let agent = proposal["agent"].as_str().ok_or("proposal missing agent")?;
        if !valid_persona_name(agent) {
            return Err("bad agent name in proposal".to_string());
        }
        let to = proposal["to"].as_str().ok_or("proposal missing new description")?;
        let persona_path = persona_dir()?.join(format!("{agent}.md"));
        let content = std::fs::read_to_string(&persona_path).map_err(|e| format!("persona unreadable: {e}"))?;
        let updated = if content.lines().any(|l| l.starts_with("description:")) {
            content
                .lines()
                .map(|l| if l.starts_with("description:") { format!("description: {to}") } else { l.to_string() })
                .collect::<Vec<_>>()
                .join("\n") + "\n"
        } else {
            content.replacen("---\n", &format!("---\ndescription: {to}\n"), 1)
        };
        std::fs::write(&persona_path, updated).map_err(|e| format!("apply failed: {e}"))?;
    }
    let decision = serde_json::json!({
        "type": "decision",
        "id": id,
        "ts": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        "status": if approve { "approved" } else { "denied" },
    });
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(file, "{}", decision).map_err(|e| e.to_string())
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
    // ~/.fez may not exist yet on a machine where nothing else created it
    // — every other settings writer mkdirs first; this one forgot.
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
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
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut settings: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("settings.json unreadable: {e}"))?;
    if let Some(servers) = settings.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        servers.remove(&name);
    }
    std::fs::write(&path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n")
        .map_err(|e| format!("write failed: {e}"))
}

/// Copy the bundled Built-in agent (pi + pi-acp + assets) out of the app
/// bundle into ~/.fez/bin on launch. Buzz ships buzz-agent as an in-app
/// sidecar; fez bundles the same way but copies to its OWNED bin dir,
/// because the SENTINEL (a launchd process outside this app) spawns agents
/// and resolves ~/.fez/bin — a sidecar buried in the .app is unreachable to
/// it. Version-gated: a no-op on every launch after the bundled version is
/// already installed, so it's cheap. The marker is stamped ONLY after every
/// copy succeeded — the first version stamped it unconditionally, so one
/// transient failure (disk full, quarantined dest) skipped the copy on
/// every launch forever, and the only cure was hand-deleting the marker.
/// Now a failed install simply retries next launch; until one succeeds the
/// user falls back to a system pi if they have one.
fn install_bundled_agent(src: std::path::PathBuf) {
    // A build made without bun ships a marker but no binary (see
    // prepare-pi-agent.mjs) — nothing to install, fall back to system pi.
    if !src.join("pi").exists() {
        return;
    }
    // An unreadable VERSION becomes "" — still stamped and still compared,
    // so it gates like any other version instead of forcing a ~140MB
    // re-copy on every launch.
    let version = std::fs::read_to_string(src.join("VERSION")).unwrap_or_default();
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };
    let bin = std::path::Path::new(&home).join(".fez").join("bin");
    let marker = bin.join(".pi-agent-version");
    if std::fs::read_to_string(&marker).ok().as_deref() == Some(&version) {
        return; // already current
    }
    match copy_agent_files(&src, &bin) {
        Ok(()) => {
            // A failed stamp is not an error: the files are in place and
            // next launch just re-copies before stamping again.
            let _ = std::fs::write(&marker, &version);
            eprintln!("✓ installed bundled agent {version} → {}", bin.display());
        }
        Err(e) => eprintln!("bundled agent install failed ({e}) — will retry next launch"),
    }
}

/// Every file the bundle ships is required for a successful install —
/// pi + pi-acp executable, theme (pi needs it even in --mode rpc), and
/// the wasm behind the image tools. Any failure aborts before the
/// version marker is stamped.
fn fez_relay_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".fez").join("relay")
}

fn pid_alive(pidfile: &std::path::Path) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(pidfile).ok()?.trim().parse().ok()?;
    // kill -0: alive. /bin/kill keeps this file's no-extra-crates rule.
    let ok = Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    ok.then_some(pid)
}

/// Is the local workspace relay running? Pidfile + kill -0, the same
/// convention as the CLI sentinel's pidfile.
#[tauri::command]
fn local_relay_status() -> bool {
    pid_alive(&fez_relay_dir().join("relay.pid")).is_some()
}

/// Spawn (or adopt) the user-owned local relay and wait until its NIP-11
/// answers. Creating ~/.fez/relay is the durable "this machine chose a
/// local workspace" marker — .setup() respawns on it every launch.
///
/// The relay reads its identity from FLAGS, not its store — a restart
/// without --owner would serve an UNCLAIMED workspace (fez-relay/src/
/// cli.ts). So the first spawn persists its args to args.json and every
/// respawn replays them; a restart can never change owner or name.
#[tauri::command]
fn ensure_local_relay(owner: String, name: String) -> Result<String, String> {
    let dir = fez_relay_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let args_file = dir.join("args.json");
    let (owner, name) = if owner.is_empty() {
        let raw = std::fs::read_to_string(&args_file)
            .map_err(|_| "no local workspace to respawn (missing args.json)".to_string())?;
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("args.json: {e}"))?;
        (
            v["owner"].as_str().unwrap_or_default().to_string(),
            v["name"].as_str().unwrap_or_default().to_string(),
        )
    } else {
        let v = serde_json::json!({ "owner": owner, "name": name });
        std::fs::write(&args_file, v.to_string()).map_err(|e| format!("args.json: {e}"))?;
        (owner, name)
    };
    if owner.len() != 64 || !owner.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("local relay needs a 64-hex owner pubkey".to_string());
    }
    let pidfile = dir.join("relay.pid");
    if pid_alive(&pidfile).is_none() {
        let home = std::env::var("HOME").unwrap_or_default();
        let bin = std::path::PathBuf::from(&home).join(".fez").join("bin").join("fez-relay");
        if !bin.exists() {
            return Err(
                "fez-relay isn't bundled in this build — join a workspace by invite instead"
                    .to_string(),
            );
        }
        let child = Command::new(&bin)
            .args([
                "--port",
                "7777",
                "--store",
                &dir.join("events.jsonl").to_string_lossy(),
                "--owner",
                &owner,
                "--name",
                if name.is_empty() { "your workspace" } else { &name },
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn fez-relay: {e}"))?;
        std::fs::write(&pidfile, child.id().to_string()).map_err(|e| format!("pidfile: {e}"))?;
    }
    // Health: NIP-11 on the http origin, up to 5s.
    for _ in 0..10 {
        if ureq::get("http://127.0.0.1:7777")
            .set("Accept", "application/nostr+json")
            .timeout(std::time::Duration::from_millis(500))
            .call()
            .is_ok()
        {
            return Ok("ws://127.0.0.1:7777".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err("local relay didn't come up within 5s — check ~/.fez/relay".to_string())
}

/// Something is watching mentions: the CLI sentinel's pidfile is alive.
#[tauri::command]
fn runner_status() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    pid_alive(&std::path::PathBuf::from(home).join(".fez").join("sentinel.pid")).is_some()
}

/// Best effort: if the fez CLI exists on this machine, start its sentinel
/// detached. Ok(false) means "no CLI here" — the UI says so honestly
/// instead of promising a reply that cannot come. Bundling the full
/// runner chain (sentinel → fez agent → fez-acp) is the standalone-DMG
/// follow-up, out of scope for the cold-start work.
#[tauri::command]
fn ensure_agent_runner() -> Result<bool, String> {
    if runner_status() {
        return Ok(true);
    }
    // Same real-install-dirs idea harness_installed uses: a GUI app's
    // PATH is stripped, so look where installers actually put things.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.fez/bin/fez"),
        "/opt/homebrew/bin/fez".to_string(),
        "/usr/local/bin/fez".to_string(),
        format!("{home}/.local/bin/fez"),
        format!("{home}/.bun/bin/fez"),
        format!("{home}/.volta/bin/fez"),
    ];
    let Some(fez) = candidates.iter().find(|p| std::path::Path::new(p.as_str()).exists()) else {
        return Ok(false);
    };
    Command::new(fez)
        .arg("sentinel")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn fez sentinel: {e}"))?;
    Ok(true)
}

fn copy_agent_files(src: &std::path::Path, bin: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin).map_err(|e| format!("mkdir {}: {e}", bin.display()))?;
    // fez-relay is optional: dev builds without bun don't produce it, and
    // the app degrades to invite-only workspaces. pi/pi-acp stay required.
    for (name, required) in [("pi", true), ("pi-acp", true), ("fez-relay", false)] {
        if !required && !src.join(name).exists() {
            continue;
        }
        // Stage next to the destination, then rename: the rename is atomic,
        // so the sentinel can never spawn a half-copied executable, and
        // replacing a RUNNING pi swaps the directory entry instead of
        // writing into a busy inode.
        let staged = bin.join(format!(".{name}.staging"));
        let dst = bin.join(name);
        std::fs::copy(src.join(name), &staged).map_err(|e| format!("copy {name}: {e}"))?;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {name}: {e}"))?;
        // fs::copy preserves xattrs on macOS — including com.apple.quarantine
        // when the app itself was downloaded, which makes Gatekeeper kill the
        // copied binary the moment the sentinel spawns it. Strip it; "no such
        // xattr" (a dev build) is the normal case and not an error.
        let _ = Command::new("/usr/bin/xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&staged)
            .output();
        std::fs::rename(&staged, &dst).map_err(|e| format!("rename {name}: {e}"))?;
    }
    // Replace the theme dir wholesale — additive copies left stale files
    // from older agent versions behind forever.
    let theme_dst = bin.join("theme");
    let _ = std::fs::remove_dir_all(&theme_dst);
    std::fs::create_dir_all(&theme_dst).map_err(|e| format!("mkdir theme: {e}"))?;
    let entries = std::fs::read_dir(src.join("theme")).map_err(|e| format!("read theme: {e}"))?;
    for e in entries {
        let e = e.map_err(|e| format!("read theme: {e}"))?;
        std::fs::copy(e.path(), theme_dst.join(e.file_name()))
            .map_err(|err| format!("copy theme/{}: {err}", e.file_name().to_string_lossy()))?;
    }
    std::fs::copy(src.join("photon_rs_bg.wasm"), bin.join("photon_rs_bg.wasm"))
        .map_err(|e| format!("copy photon_rs_bg.wasm: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // artifact://localhost/<id> — the staged-doc server. Not found is
        // a real 404: a released or evicted doc renders an empty frame,
        // never someone else's content.
        .register_uri_scheme_protocol("artifact", |_ctx, request| {
            let id = request.uri().path().trim_start_matches('/').parse::<u64>().ok();
            match id.and_then(artifact_doc) {
                Some(doc) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(doc.into_bytes())
                    .unwrap_or_default(),
                None => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap_or_default(),
            }
        })
        .setup(|app| {
            // Off the main thread: the copy moves ~140MB on a version bump,
            // and running it synchronously here held the window back —
            // first launch looked hung with no window and no progress.
            use tauri::Manager;
            if let Ok(dir) = app.path().resource_dir() {
                std::thread::spawn(move || install_bundled_agent(dir.join("pi-agent")));
            }
            // A machine that chose a local workspace gets its relay back on
            // every launch — args.json replays the original owner/name, so
            // a restart can never change the workspace's identity.
            if fez_relay_dir().join("args.json").exists() {
                std::thread::spawn(|| {
                    if let Err(e) = ensure_local_relay(String::new(), String::new()) {
                        eprintln!("local relay respawn: {e}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![stage_artifact, release_artifact, get_identity, set_identity, write_persona, list_personas, read_persona, update_persona, rename_persona, delete_persona, list_gui_extensions, list_local_extensions, read_extension_grants, list_persona_drafts, read_persona_draft, approve_persona_draft, reject_persona_draft, write_persona_draft, read_skills, write_skill, remove_skill, set_skill_secret, has_skill_secret, read_bench_proposals, decide_bench_proposal, read_keymap, write_keymap, install_package, remove_extension, read_extension_versions, latest_version, package_info, export_tool, wire_chutes_pi, detect_harnesses, ensure_local_relay, local_relay_status, runner_status, ensure_agent_runner])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
