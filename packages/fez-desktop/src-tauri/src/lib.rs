use nostr::JsonUtil as _;
mod git_install;
mod managed_agents;
mod managed_node;
mod package_install;
mod package_migrate;
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
/// Synchronize agent-registry read-modify-write across Tauri command invocations
/// to prevent lost updates when spawn_agent and kill_agent race.
static AGENTS_REGISTRY_LOCK: Mutex<()> = Mutex::new(());
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

// ── key custody ─────────────────────────────────────────────────────
// The identity key stays HERE. The webview asks for a pubkey, for
// signatures, and for DM crypto — never the secret (Buzz's custody
// model). get_identity survives above as the EXPLICIT reveal used by
// backup/settings; nothing on the boot or messaging path calls it.

/// Keys per account, loaded from the keychain once per launch — DM
/// history decrypt would otherwise spawn `security` per event.
static IDENTITY_KEYS: Mutex<Option<std::collections::HashMap<String, nostr::Keys>>> =
    Mutex::new(None);

fn load_keys(account: Option<String>) -> Result<nostr::Keys, String> {
    let name = account.clone().unwrap_or_else(|| "default".to_string());
    {
        let guard = IDENTITY_KEYS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(keys) = guard.as_ref().and_then(|m| m.get(&name)) {
            return Ok(keys.clone());
        }
    }
    let hex = get_identity(account)?;
    let keys = nostr::Keys::parse(&hex).map_err(|e| format!("bad identity key: {e}"))?;
    let mut guard = IDENTITY_KEYS.lock().unwrap_or_else(|p| p.into_inner());
    guard.get_or_insert_with(Default::default).insert(name, keys.clone());
    Ok(keys)
}

/// The boot call: who am I — and nothing else crosses the bridge.
#[tauri::command]
fn get_pubkey(account: Option<String>) -> Result<String, String> {
    Ok(load_keys(account)?.public_key().to_hex())
}

fn parse_tags(tags: Vec<Vec<String>>) -> Result<Vec<nostr::Tag>, String> {
    tags.into_iter()
        .map(|t| nostr::Tag::parse(t).map_err(|e| format!("bad tag: {e}")))
        .collect()
}

/// Build and sign one event from an already-parsed template.
///
/// `allow_self_tagging` is load-bearing, not decoration. nostr-rs strips
/// any `p` tag matching the author during `build` unless it is set —
/// "removes any `p` tags that match the author's public key". A reminder
/// is addressed to ITSELF (`["p", <own pubkey>]`), so the tag vanished
/// between parse and signature and the event reached the relay untagged;
/// every `#p` query then missed it, silently, because a stripped tag is
/// an error nowhere. A signer signs what it was asked to sign; deciding
/// which of the caller's tags are worth keeping is not its job.
fn build_event(
    kind: u16,
    content: String,
    tags: Vec<nostr::Tag>,
    created_at: Option<u64>,
    keys: &nostr::Keys,
) -> Result<nostr::Event, String> {
    let mut builder = nostr::EventBuilder::new(nostr::Kind::from(kind), content)
        .allow_self_tagging()
        .tags(tags);
    if let Some(ts) = created_at {
        builder = builder.custom_created_at(nostr::Timestamp::from(ts));
    }
    builder.sign_with_keys(keys).map_err(|e| format!("sign failed: {e}"))
}

/// Sign one event template — the webview's finalizeEvent, minus the key.
#[tauri::command]
async fn sign_event(
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
    created_at: Option<u64>,
    account: Option<String>,
) -> Result<String, String> {
    let keys = load_keys(account)?;
    let event = build_event(kind, content, parse_tags(tags)?, created_at, &keys)?;
    Ok(event.as_json())
}

#[tauri::command]
fn nip44_encrypt(peer: String, plaintext: String, account: Option<String>) -> Result<String, String> {
    let keys = load_keys(account)?;
    let peer = nostr::PublicKey::from_hex(&peer).map_err(|e| format!("bad peer pubkey: {e}"))?;
    nostr::nips::nip44::encrypt(keys.secret_key(), &peer, plaintext, nostr::nips::nip44::Version::V2)
        .map_err(|e| format!("encrypt failed: {e}"))
}

#[tauri::command]
fn nip44_decrypt(peer: String, ciphertext: String, account: Option<String>) -> Result<String, String> {
    let keys = load_keys(account)?;
    let peer = nostr::PublicKey::from_hex(&peer).map_err(|e| format!("bad peer pubkey: {e}"))?;
    nostr::nips::nip44::decrypt(keys.secret_key(), &peer, ciphertext)
        .map_err(|e| format!("decrypt failed: {e}"))
}

/// Gift-wrap ONE DM rumor for every recipient (NIP-59: seal, then wrap
/// per key). One command for the whole set because the rumor's identity
/// must be shared — per-recipient rumors would give every member of a
/// group DM a different message id. Returns {"rumorId", "wraps": [json]}.
#[tauri::command]
async fn dm_wrap_all(
    kind: u16,
    content: String,
    tags: Vec<Vec<String>>,
    recipients: Vec<String>,
    account: Option<String>,
) -> Result<String, String> {
    let keys = load_keys(account)?;
    let mut rumor = nostr::EventBuilder::new(nostr::Kind::from(kind), content)
        .tags(parse_tags(tags)?)
        .build(keys.public_key());
    let rumor_id = rumor.id().to_hex();
    let mut wraps: Vec<serde_json::Value> = Vec::new();
    for recipient in recipients {
        let pk = nostr::PublicKey::from_hex(&recipient).map_err(|e| format!("bad recipient: {e}"))?;
        let wrap = nostr::EventBuilder::gift_wrap(&keys, &pk, rumor.clone(), [])
            .await
            .map_err(|e| format!("wrap failed: {e}"))?;
        wraps.push(serde_json::from_str(&wrap.as_json()).map_err(|e| e.to_string())?);
    }
    Ok(serde_json::json!({ "rumorId": rumor_id, "wraps": wraps }).to_string())
}

/// Unwrap an incoming gift wrap to its rumor (JSON), or error.
#[tauri::command]
async fn dm_unwrap(event: String, account: Option<String>) -> Result<String, String> {
    let keys = load_keys(account)?;
    let wrap = nostr::Event::from_json(&event).map_err(|e| format!("bad event: {e}"))?;
    let gift = nostr::nips::nip59::UnwrappedGift::from_gift_wrap(&keys, &wrap)
        .await
        .map_err(|e| format!("unwrap failed: {e}"))?;
    let mut rumor = gift.rumor;
    // The rumor id is the DM's identity (dedup, threading) — make sure
    // the JSON carries it even when the sender left it uncomputed.
    rumor.ensure_id();
    Ok(rumor.as_json())
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
/// creation. The MD file is the whole contract: the desktop's summoner
/// spawns the agent on its first @mention. Refuses overwrite; existing
/// personas are edited in an editor, not silently replaced from a dialog.
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
/// (~/.fez/packages/<name>/, per each manifest's `fez.parts.gui`). The
/// webview imports each as an ES module and calls its activate(api) — the
/// GUI's version of the TUI's extension loader.
#[tauri::command]
fn list_gui_extensions() -> Result<Vec<(String, String, String)>, String> {
    let home_path = fez_home()?;
    Ok(package_install::gui_parts(&home_path))
}

/// Read one extension's state file (~/.fez/extension-data/<name>.json)
/// whole, as text. The gui loader namespaces calls to the extension's
/// own stem — this command only enforces that the name can't traverse.
/// Read-only: gui parts render state; headless/CLI own writes.
#[tauri::command]
fn extension_storage_read(name: String) -> Result<String, String> {
    let ok_first = name
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let ok_rest = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok_first || !ok_rest || name.contains("..") {
        return Err(format!("invalid extension name: {name}"));
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let file = std::path::Path::new(&home)
        .join(".fez")
        .join("extension-data")
        .join(format!("{name}.json"));
    Ok(std::fs::read_to_string(file).unwrap_or_else(|_| "{}".to_string()))
}

/// Write ONE key under an extension's `prefs` object
/// (~/.fez/extension-data/<name>.json). Name validation mirrors
/// `extension_storage_read` verbatim.
///
/// Scoped to `prefs` on purpose: the CLI rewrites the rest of this file
/// on every spend, so a webview writing those keys would clobber ledger
/// rows outright. The scoping is what keeps a panel write from ever
/// TARGETING a CLI-owned key; it does not serialize the two writers.
/// This function read-modify-writes the whole file, and so does the node
/// side, from a different process — two concurrent writes can still lose
/// an update. This is a correctness boundary — gui parts run in the page
/// and can reach every command regardless, so it is not, and must not be
/// described as, a security boundary.
#[tauri::command]
fn extension_storage_write(name: String, key: String, value: String) -> Result<(), String> {
    let ok_first = name
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let ok_rest = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok_first || !ok_rest || name.contains("..") {
        return Err(format!("invalid extension name: {name}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&value).map_err(|e| format!("invalid value json: {e}"))?;
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".fez").join("extension-data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{name}.json"));
    let mut state: serde_json::Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !state.is_object() {
        state = serde_json::json!({});
    }
    if !state["prefs"].is_object() {
        state["prefs"] = serde_json::json!({});
    }
    state["prefs"][key] = parsed;
    std::fs::write(&file, serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
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

/// Which agent harnesses are actually installed — the ACP bridges each one
/// speaks through (claude-code → claude-agent-acp, pi → pi-acp). A GUI app
/// gets a stripped PATH, so we look in the real install dirs (homebrew,
/// /usr/local, every nvm node version, plus whatever PATH we do have)
/// rather than trusting `which`. Returns {"claude-code": bool, "pi": bool}
/// so the UI can show what's ready and what needs installing.
fn harness_installed(cmd: &str) -> bool {
    binary_in_dirs(cmd, &harness_search_dirs())
}

/// Every place an installer actually puts things — shared by harness
/// detection and the claude auth probe, so the two can't disagree about
/// where `claude` lives.
fn harness_search_dirs() -> Vec<String> {
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
    // The Claude native installer's home (~/.claude/local) — the cask and
    // install.sh symlink into ~/.local/bin and /opt/homebrew/bin (already
    // listed), but an unlinked native install lives only here.
    dirs.push(format!("{home}/.claude/local"));
    dirs
}

/// Composite state for the onboarding brain card: Buzz's two claims kept
/// separate — "installed" (the CLI exists) and "signed in" (its auth
/// probe says so) — plus whether fez's managed adapter is runnable.
/// READY may only be claimed when all three hold.
#[tauri::command]
fn claude_brain_status() -> Result<String, String> {
    let dirs = harness_search_dirs();
    let claude = dirs
        .iter()
        .map(|d| std::path::Path::new(d).join("claude"))
        .find(|p| p.is_file());
    let installed = claude.is_some();
    let authed = match &claude {
        Some(path) => {
            // 10s kill deadline, Buzz's number — a hung probe must not
            // hang onboarding.
            match Command::new(path).args(["auth", "status"]).output() {
                Ok(out) => managed_node::parse_claude_auth(&String::from_utf8_lossy(&out.stdout))
                    .or_else(|| managed_node::parse_claude_auth(&String::from_utf8_lossy(&out.stderr)))
                    .unwrap_or(false),
                Err(_) => false,
            }
        }
        None => false,
    };
    Ok(serde_json::json!({
        "installed": installed,
        "authed": authed,
        "adapterReady": managed_node::adapter_ready(),
    })
    .to_string())
}

/// Provision the private node runtime + the Claude ACP adapter — the
/// managed-npm decision (see managed_node.rs). First run downloads and
/// takes tens of seconds; the brain card owns the spinner.
#[tauri::command]
fn ensure_claude_adapter() -> Result<String, String> {
    managed_node::ensure_claude_adapter()
}

/// Executable, not merely present — a copy that landed without its exec
/// bit (or a directory of the same name) must not report as installed.
fn binary_in_dirs(cmd: &str, dirs: &[String]) -> bool {
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
        // The VENDOR CLI is the question, not the ACP adapter — fez
        // bundles claude-agent-acp into ~/.fez/bin (same as pi-acp), so a
        // user who installed Claude Code must never read "not detected"
        // because an npm package they've never heard of is missing.
        // (Buzz's two-axis availability, collapsed by shipping the axis
        // that was ours to ship.)
        "claude-code": harness_installed("claude"),
        "pi": harness_installed("pi-acp"),
    });
    Ok(map.to_string())
}

/// A brain the onboarding/settings UI can wire into pi as a local-models
/// provider: id/name for display, the base URL pi's local-models extension
/// will call, the keychain key name (namespaced "<id>.<key_name>" in
/// service "fez-skill-env"), and how the models-listing probe authenticates.
struct ProviderSpec {
    /// UI id and skill-secret namespace ("chutes" → account "chutes.CHUTES_API_KEY").
    id: &'static str,
    name: &'static str,
    base_url: &'static str,
    key_name: &'static str,
    /// How the models-listing endpoint authenticates.
    auth: ProviderAuth,
}

enum ProviderAuth {
    Bearer,
    XApiKey,
}

/// The v1 provider table — chutes/anthropic/openai/openrouter. Adding a
/// provider is adding a row here; wire_provider_pi and provider_key_present
/// are both fully data-driven off it.
fn provider_spec(id: &str) -> Option<&'static ProviderSpec> {
    const PROVIDERS: &[ProviderSpec] = &[
        ProviderSpec { id: "chutes", name: "Chutes", base_url: "https://llm.chutes.ai/v1", key_name: "CHUTES_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "anthropic", name: "Anthropic", base_url: "https://api.anthropic.com/v1", key_name: "ANTHROPIC_API_KEY", auth: ProviderAuth::XApiKey },
        ProviderSpec { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", key_name: "OPENAI_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_name: "OPENROUTER_API_KEY", auth: ProviderAuth::Bearer },
    ];
    PROVIDERS.iter().find(|p| p.id == id)
}

/// pi's local-models provider id: "local-" + sha256(baseUrl)[..10]. This fn
/// returns just the hash fragment (the `id` field in local-models.json).
fn local_provider_id(base_url: &str) -> String {
    use sha2::{Digest, Sha256};
    let hex = hex::encode(Sha256::digest(base_url.as_bytes()));
    hex[..10].to_string()
}

/// Whether a provider's key is already in the keychain — the "already
/// wired?" check the onboarding/settings UI uses before showing a key
/// prompt.
#[tauri::command]
fn provider_key_present(provider: String) -> Result<bool, String> {
    let spec = provider_spec(&provider).ok_or_else(|| format!("unknown provider {provider}"))?;
    has_skill_secret(spec.id.to_string(), spec.key_name.to_string())
}

/// Wire a provider into pi as a local-models endpoint and return the
/// models — the backend for the agent editor's "runs on: <provider>"
/// option. Reads the provider's key from the keychain (set in Settings →
/// secrets), registers the endpoint in ~/.pi/agent/local-models.json (pi's
/// local-models extension turns it into provider `local-<id>`), and
/// returns {provider, models}. The editor sets the persona's
/// provider/model itself, so this creates no persona. Provider id is
/// sha256(base_url)[:10], fixed because each provider's base url is fixed.
#[tauri::command]
fn wire_provider_pi(provider: String) -> Result<String, String> {
    let spec = provider_spec(&provider).ok_or_else(|| format!("unknown provider {provider}"))?;
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;

    let key = Command::new("security")
        .args(["find-generic-password", "-s", "fez-skill-env", "-a", &format!("{}.{}", spec.id, spec.key_name), "-w"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("No {} key yet — add it first.", spec.name))?;

    let frag = local_provider_id(spec.base_url);
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
    endpoints.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(frag.as_str()));
    endpoints.push(serde_json::json!({ "id": frag, "name": spec.name, "baseUrl": spec.base_url, "apiKey": key, "status": "checking" }));
    if let Some(parent) = cfg.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&endpoints).map_err(|e| e.to_string())?;
    std::fs::write(&cfg, text + "\n")
        .map_err(|e| format!("couldn't write pi local-models.json: {e}"))?;

    // The proof is a live model list. Anthropic's native listing wants
    // x-api-key + anthropic-version; the OpenAI-compat providers take Bearer.
    let req = ureq::get(&format!("{}/models", spec.base_url)).timeout(std::time::Duration::from_secs(30));
    let req = match spec.auth {
        ProviderAuth::Bearer => req.set("authorization", &format!("Bearer {key}")),
        ProviderAuth::XApiKey => req.set("x-api-key", &key).set("anthropic-version", "2023-06-01"),
    };
    let body = req
        .call()
        .map_err(|e| format!("{} wired, but couldn't list models: {e}", spec.name))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let models: Vec<String> = parsed
        .pointer("/data")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    if models.is_empty() {
        return Err(format!("{} returned no models", spec.name));
    }
    Ok(serde_json::json!({ "provider": format!("local-{frag}"), "models": models }).to_string())
}

/// Kept as a thin wrapper so existing webview callers (ModelPicker,
/// Onboarding) that invoke `wire_chutes_pi` directly keep working.
#[tauri::command]
fn wire_chutes_pi() -> Result<String, String> {
    wire_provider_pi("chutes".into())
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
    let pkg_bytes = package_install::tar_read(&tar_bytes, "package.json").ok_or("no package.json in tarball")?;
    let pkg: serde_json::Value =
        serde_json::from_slice(&pkg_bytes).map_err(|e| format!("bad package.json: {e}"))?;

    // 3b. Compat gate — BEFORE anything is copied, same as the CLI's
    // install and link. The gallery used to bypass this entirely: a
    // package built against a newer FezExtensionAPI installed fine and
    // hit an undefined method three layers into someone's afternoon.
    if let Some(err) = min_fez_version_error(
        pkg.pointer("/fez/minFezVersion").and_then(|v| v.as_str()),
        FEZ_VERSION,
    ) {
        return Err(format!("{name} {err}"));
    }

    finish_install(&name, &tar_bytes, latest)
}

/// Shared tail for every install path (npm registry, git repo): place the
/// tarball's parts into ~/.fez/packages/<base>/, index them into the flat
/// dirs, and record granted permissions + background opt-in in
/// settings.json. See package_install for the on-disk layout (shared with
/// the CLI's PackageManager).
fn finish_install(name: &str, tar_bytes: &[u8], version: &str) -> Result<String, String> {
    let home = fez_home()?;
    // The emptiness check (no installable gui/headless/relay/workspace/
    // persona part) and the bin-collision refusal both now live INSIDE
    // install_from_tarball, before any write — a refused install must
    // leave nothing on disk, not an orphan packages/<base>/package.json.
    let outcome = package_install::install_from_tarball(name, tar_bytes, version, &home)?;

    // Fed from the outcome; install_from_tarball never touches settings.
    let base_owned = outcome.base.clone();
    let skill_entry = outcome.skill_entry.clone();
    let perms = outcome.perms.clone();
    let wants_background = outcome.wants_background;
    update_settings(move |json| {
        // update_settings guarantees an object; the members do NOT come
        // with that guarantee (hand-edited files) — obj_entry resets a
        // wrong-typed value instead of panicking mid-install.
        let obj = json.as_object_mut().unwrap();
        if let Some(entry) = skill_entry {
            obj_entry(obj, "mcpServers").insert(base_owned.clone(), entry);
        }
        obj_entry(obj, "extensionPermissions").insert(base_owned.clone(), serde_json::json!(perms));
        // Version and bins are no longer cached here — they live in
        // packages/<base>/package.json, read back by installed_version and
        // extension_may_spawn.
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

    Ok(format!("installed {name}@{version}: {}", outcome.installed.join(", ")))
}

/// Inspect a GitHub repo (owner/repo, optional #ref) without installing
/// anything: fetch by resolved sha, run it through `git_install::convert`,
/// and hand back the report as JSON for the confirm-before-install card.
#[tauri::command]
fn inspect_git_package(url: String) -> Result<String, String> {
    let (owner, repo, want_ref) = git_install::parse_github_url(&url)?;
    let (tar_bytes, sha) = git_install::fetch(&owner, &repo, want_ref.as_deref())?;
    let (report, _npm_tar) = git_install::convert(&tar_bytes, &owner, &repo, &url, &sha)?;
    let installed = package_install::installed_manifest(&report.name, &fez_home()?).is_some();
    let mut value = serde_json::to_value(&report).map_err(|e| e.to_string())?;
    let obj = value.as_object_mut().ok_or("bad report")?;
    obj.insert("sha".to_string(), serde_json::json!(sha));
    obj.insert("url".to_string(), serde_json::json!(url));
    obj.insert("installed".to_string(), serde_json::json!(installed));
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

/// Install a GitHub repo as a persona pack: fetch by resolved sha, convert,
/// and — unless the repo is refused (code files, hooks) — run it through
/// the same install tail as an npm package.
#[tauri::command]
fn install_git_package(url: String) -> Result<String, String> {
    let (owner, repo, want_ref) = git_install::parse_github_url(&url)?;
    let (tar_bytes, sha) = git_install::fetch(&owner, &repo, want_ref.as_deref())?;
    let (report, npm_tar) = git_install::convert(&tar_bytes, &owner, &repo, &url, &sha)?;
    let Some(npm_tar) = npm_tar else {
        return Err(format!("{} refused: {}", report.name, report.refused.join(", ")));
    };
    let version = format!("0.0.0-{}", &sha[..sha.len().min(7)]);
    finish_install(&report.name, &npm_tar, &version)
}

/// The installed version per extension, as JSON. The package dir
/// (`packages/<base>/package.json`, via `installed_version`) is the source
/// of truth; settings.json's old `extensionVersions` cache is kept only as
/// a fallback for installs from before this layout that haven't been
/// migrated yet (Task 7) — where both know a name, the package dir wins.
#[tauri::command]
fn read_extension_versions() -> Result<String, String> {
    let home = fez_home()?;
    let raw = std::fs::read_to_string(home.join("settings.json")).unwrap_or_else(|_| "{}".to_string());
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    let mut versions = parsed
        .get("extensionVersions")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(home.join("packages")) {
        for entry in entries.flatten() {
            if let Some(base) = entry.file_name().to_str() {
                if let Some(v) = package_install::installed_version(base, &home) {
                    versions.insert(base.to_string(), serde_json::json!(v));
                }
            }
        }
    }
    Ok(serde_json::Value::Object(versions).to_string())
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

    // Modern path: packages/<base>/package.json is the package's own record
    // of what it installed — remove exactly that, deleting each flat-index
    // entry only if this package still owns it, then the package dir
    // itself. `Err` from every candidate means none has a package dir —
    // fall back to the legacy name-guess sweep below (installs from before
    // this layout, until Task 7's migration retires it).
    let modern = candidates
        .iter()
        .find_map(|cand| package_install::remove_installed(cand, &home).ok());
    if let Some(list) = modern {
        removed.extend(list);
    } else {
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
    }
    // Drop the recorded permission grant + background opt-in, and collect
    // the bins this package installed so their files go too.
    let mut bins_to_remove: Vec<String> = Vec::new();
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
                if let Some(bins) = obj.get_mut("extensionBins").and_then(|v| v.as_object_mut()) {
                    if let Some(list) = bins.remove(cand) {
                        if let Some(list) = list.as_array() {
                            bins_to_remove
                                .extend(list.iter().filter_map(|v| v.as_str().map(String::from)));
                        }
                    }
                }
            }
        }
    })?;
    for cmd in &bins_to_remove {
        if !package_install::safe_bin_name(cmd) {
            continue;
        }
        let file = home.join("bin").join(cmd);
        if file.exists() && std::fs::remove_file(&file).is_ok() {
            removed.push(format!("bin/{cmd}"));
        }
    }
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
/// and gui (packages/*/ whose manifest declares fez.parts.gui — install no
/// longer leaves a gui-extensions/ symlink for this to scan). Skill parts
/// live in settings.json and are listed separately — a package can have
/// any mix of the three. Thin wrapper: the testable core lives in
/// package_install.rs (local_extensions), same split as gui_parts.
#[tauri::command]
fn list_local_extensions() -> Result<Vec<(String, Vec<String>)>, String> {
    Ok(package_install::local_extensions(&fez_home()?))
}

/// Every installed skill (`fez.skills` packages), as JSON `[{pkg, id, name,
/// description}]` — the webview's install-manager listing. No `path`: the
/// webview never touches the filesystem directly. Thin wrapper — the
/// testable core (`installed_skills`) lives in package_install.rs, same
/// split as `list_local_extensions`/`local_extensions`.
#[tauri::command]
fn list_installed_skills() -> Result<String, String> {
    serde_json::to_string(&package_install::installed_skills(&fez_home()?)).map_err(|e| e.to_string())
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

/// A settings.json mcpServers key. Deliberately the same shape the GUI's
/// skill-attach.ts enforces before writing one into a persona: npm's own
/// name grammar plus `@` and `/` for scoped names. A skill name can
/// arrive from a relay listing (a stranger's string), and a name
/// carrying `]` and a newline is a frontmatter injection one hop later —
/// so it is refused here too, and never reaches settings.json either.
fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '/' | '-'))
}

#[tauri::command]
fn write_skill(name: String, config_json: String) -> Result<(), String> {
    if !valid_skill_name(&name) {
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

/// What answered a NIP-11 probe on a loopback port.
#[derive(Debug, PartialEq, Clone, Copy)]
enum PortState {
    /// Nothing listening — ours to bind.
    Free,
    /// A fez relay whose NIP-11 owner is OUR key — adopt, don't respawn.
    Ours,
    /// Something else — another user's relay, another service. Never adopt:
    /// localhost ports are machine-global, and health-checking blindly
    /// walked a fresh account into another session's workspace.
    Foreign,
}

/// Pick the port the local relay lives on: the desired port first, then a
/// short scan past foreign squatters. Returns (port, already_ours) — None
/// when every candidate is foreign (guessing further helps nobody).
fn choose_relay_port(desired: u16, probe: impl Fn(u16) -> PortState) -> Option<(u16, bool)> {
    for port in desired..desired.saturating_add(10) {
        match probe(port) {
            PortState::Ours => return Some((port, true)),
            PortState::Free => return Some((port, false)),
            PortState::Foreign => continue,
        }
    }
    None
}

/// pid_alive, but the process must actually BE the named program. A bare
/// kill -0 believes any process wearing the pid — macOS reuses low pids
/// after a reboot, so a stale relay.pid matched some unrelated process,
/// the respawn was skipped, and the app sat at "reconnecting…" forever.
fn pid_alive_named(pidfile: &std::path::Path, name: &str) -> Option<u32> {
    let pid = pid_alive(pidfile)?;
    let out = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let comm = String::from_utf8_lossy(&out.stdout);
    let comm = comm.trim();
    (comm == name || comm.ends_with(&format!("/{name}"))).then_some(pid)
}

/// The GUI's write-through for the relay set. localStorage is only the
/// webview's cache; ~/.fez/settings.json is the custody every other
/// surface reads (sentinel watch, CLI, doctor) — a GUI that wrote only
/// its own cache left the sentinel guarding an abandoned workspace.
#[tauri::command]
fn write_relays(relays: Vec<String>) -> Result<(), String> {
    if relays.is_empty() || relays.len() > 16 {
        return Err("relay set must have 1–16 entries".to_string());
    }
    for r in &relays {
        if !(r.starts_with("ws://") || r.starts_with("wss://")) || r.len() > 200 {
            return Err(format!("not a relay url: {r}"));
        }
    }
    update_settings(move |json| {
        let obj = json.as_object_mut().unwrap();
        obj.insert("relays".to_string(), serde_json::json!(relays));
        // drop the legacy singular key so the two can never disagree
        obj.remove("relay");
    })
}

/// Read the Blossom media server from ~/.fez/settings.json.
///
/// The webview can't read the file itself, and settings.json is the
/// authority: the CLI writes it, and every agent builds its media fetch
/// allowlist from it. Without this the GUI could only ever see its own
/// cache, so a media server set anywhere else was invisible here — and
/// the boot reconcile would happily overwrite it.
#[tauri::command]
fn read_media_server() -> Result<String, String> {
    let path = fez_home()?.join("settings.json");
    let json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(json
        .get("mediaServer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

/// Persist the Blossom media server to ~/.fez/settings.json.
///
/// Same custody rule as write_relays, and the same bug if skipped: the
/// webview's localStorage is a cache only this window can read, while an
/// AGENT builds its media fetch allowlist from settings.json. A GUI that
/// wrote only its cache left every agent refusing to fetch the images the
/// user was uploading — silently, because a disallowed host is skipped,
/// not reported.
#[tauri::command]
fn write_media_server(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        // Clearing the field is legitimate — it means "back to the default".
        return update_settings(move |json| {
            if let Some(obj) = json.as_object_mut() {
                obj.remove("mediaServer");
            }
        });
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) || trimmed.len() > 200 {
        return Err(format!("not a media server url: {trimmed}"));
    }
    update_settings(move |json| {
        let obj = json.as_object_mut().unwrap();
        obj.insert("mediaServer".to_string(), serde_json::json!(trimmed));
    })
}

/// Is the local workspace relay running? Pidfile + kill -0, the same
/// convention as the CLI sentinel's pidfile.
#[tauri::command]
fn local_relay_status() -> bool {
    pid_alive_named(&fez_relay_dir().join("relay.pid"), "fez-relay").is_some()
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
    let mut desired_port: u16 = 7777;
    let (owner, name) = if owner.is_empty() {
        let raw = std::fs::read_to_string(&args_file)
            .map_err(|_| "no local workspace to respawn (missing args.json)".to_string())?;
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("args.json: {e}"))?;
        desired_port = v["port"].as_u64().unwrap_or(7777) as u16;
        (
            v["owner"].as_str().unwrap_or_default().to_string(),
            v["name"].as_str().unwrap_or_default().to_string(),
        )
    } else {
        (owner, name)
    };
    if owner.len() != 64 || !owner.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("local relay needs a 64-hex owner pubkey".to_string());
    }

    // Who is on the port? NIP-11 names the owner; only OUR relay counts.
    let probe = |port: u16| -> PortState {
        match ureq::get(&format!("http://127.0.0.1:{port}"))
            .set("Accept", "application/nostr+json")
            .timeout(std::time::Duration::from_millis(500))
            .call()
        {
            Ok(res) => {
                let doc: serde_json::Value = res
                    .into_string()
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(serde_json::Value::Null);
                if doc.get("pubkey").and_then(|v| v.as_str()) == Some(owner.as_str()) {
                    PortState::Ours
                } else {
                    PortState::Foreign
                }
            }
            Err(_) => PortState::Free,
        }
    };

    let (port, already_ours) = choose_relay_port(desired_port, probe)
        .ok_or("no loopback port near 7777 is free — every candidate hosts a foreign relay")?;

    // Persist the CHOSEN port with the identity — a respawn must come back
    // on the same port the client remembers.
    let v = serde_json::json!({ "owner": owner, "name": name, "port": port });
    std::fs::write(&args_file, v.to_string()).map_err(|e| format!("args.json: {e}"))?;

    let pidfile = dir.join("relay.pid");
    if !already_ours && pid_alive_named(&pidfile, "fez-relay").is_none() {
        let home = std::env::var("HOME").unwrap_or_default();
        let bin = std::path::PathBuf::from(&home).join(".fez").join("bin").join("fez-relay");
        if !bin.exists() {
            return Err(
                "fez-relay isn't bundled in this build — join a workspace by invite instead"
                    .to_string(),
            );
        }
        // The relay's own words survive it — a crash with /dev/null for
        // stderr left "why is the workspace dead" unanswerable.
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("relay.log"))
            .map_err(|e| format!("relay.log: {e}"))?;
        let log_err = log.try_clone().map_err(|e| format!("relay.log: {e}"))?;
        let child = Command::new(&bin)
            .args([
                "--port",
                &port.to_string(),
                "--store",
                &dir.join("events.jsonl").to_string_lossy(),
                "--owner",
                &owner,
                "--name",
                if name.is_empty() { "your workspace" } else { &name },
            ])
            .stdout(log)
            .stderr(log_err)
            .spawn()
            .map_err(|e| format!("spawn fez-relay: {e}"))?;
        std::fs::write(&pidfile, child.id().to_string()).map_err(|e| format!("pidfile: {e}"))?;
    }
    // Health: NIP-11 must answer AND name our owner — "something is
    // listening" was how another session's relay got adopted.
    for _ in 0..10 {
        if probe(port) == PortState::Ours {
            return Ok(format!("ws://127.0.0.1:{port}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err(format!("local relay didn't come up on port {port} within 5s — check ~/.fez/relay/relay.log"))
}

/// Something is watching mentions: the CLI sentinel's pidfile is alive.
#[tauri::command]
fn runner_status() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    pid_alive(&std::path::PathBuf::from(home).join(".fez").join("sentinel.pid")).is_some()
}

fn default_bin() -> String {
    "fez-agent".to_string()
}
fn is_default_bin(b: &String) -> bool {
    b == "fez-agent"
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub(crate) struct SpawnedAgent {
    persona: String,
    channels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    pid: u32,
    /// Which binary in ~/.fez/bin this row spawned. Liveness name-checks the
    /// process, so a row that does not say what it started reads as dead the
    /// moment it is not fez-agent. Absent on rows written before anything but
    /// agents was spawned — all of which were fez-agent.
    #[serde(default = "default_bin", skip_serializing_if = "is_default_bin")]
    pub(crate) bin: String,
}

fn agents_registry_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".fez").join("desktop-agents.json")
}

fn load_agents_registry() -> Vec<SpawnedAgent> {
    std::fs::read_to_string(agents_registry_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_agents_registry(rows: &[SpawnedAgent]) {
    if let Some(dir) = agents_registry_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        agents_registry_path(),
        serde_json::to_string_pretty(rows).unwrap_or_else(|_| "[]".into()),
    );
}

fn raw_pid_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Is this pid still running the binary we started under it? Rows persist
/// across reboots and macOS reuses low pids, and a bare `kill -0` believes
/// any process wearing the pid — a reused pid made agent_alive a false
/// positive and made kill_agent SIGTERM an innocent, unrelated process.
/// `command=` (full command line, not just comm) so the ~/.fez/bin/<bin>
/// path still matches on a substring.
pub(crate) fn pid_runs_bin(pid: u32, bin: &str) -> bool {
    if !raw_pid_alive(pid) {
        return false;
    }
    Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains(bin))
        .unwrap_or(false)
}

/// Mirrors the sentinel's own liveness probe (fez-sentinel/src/index.ts
/// agentProcessAlive): an agent the SENTINEL spawned (`fez agent
/// <persona>` in dev, `cli.js agent <persona>` from source) never enters
/// the desktop's pid registry at all. Without this, a sentinel that dies
/// leaves its agents running but invisible to the desktop, which then
/// double-spawns on top of them the next time it thinks a persona is
/// needed. `persona` is webview-supplied, so it's validated here too
/// (not just at call sites) before it reaches a pgrep pattern.
fn sentinel_agent_alive(persona: &str) -> bool {
    if !valid_persona_name(persona) {
        return false;
    }
    Command::new("/usr/bin/pgrep")
        .args(["-f", &format!(r"(fez|cli\.js) agent {persona}")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Same safety contract as the shared TS isSafeWork: word char first,
/// then word chars / dot / slash / dash, bounded, no `..`.
fn safe_work(value: &str) -> bool {
    if value.is_empty() || value.len() > 201 || value.contains("..") {
        return false;
    }
    let mut chars = value.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

/// Spawn the bundled agent runtime for a persona, detached, and record
/// its pid. The desktop's half of the summoner — policy lives in the
/// shared SummonEngine on the JS side; this is only mechanics.
#[tauri::command]
fn spawn_agent(
    persona: String,
    channels: Vec<String>,
    owner: String,
    relays: String,
    repo: Option<String>,
    base_branch: Option<String>,
) -> Result<u32, String> {
    spawn_agent_process(persona, channels, owner, relays, repo, base_branch)
}

/// THE spawn primitive — every agent process the desktop starts is born
/// here (Buzz's bottleneck: no caller can bypass validation, env, the
/// reap thread, the registry, or the sentinel gate by reaching a spawn
/// some other way). Returns the pid, or 0 when a live sentinel owns
/// spawning on this machine (deferred: success with no process).
pub(crate) fn spawn_agent_process(
    persona: String,
    channels: Vec<String>,
    owner: String,
    relays: String,
    repo: Option<String>,
    base_branch: Option<String>,
) -> Result<u32, String> {
    if let Some(r) = &repo {
        if !safe_work(r) {
            return Err(format!("unsafe repo name refused: {r}"));
        }
    }
    if let Some(b) = &base_branch {
        if !safe_work(b) {
            return Err(format!("unsafe branch name refused: {b}"));
        }
    }
    // One summoner per machine: a live sentinel (TUI world, opt-in fleet
    // daemon) owns spawning AGENTS. Checked here rather than in the shared
    // primitive because it is a fact about summoning, not about spawning —
    // a miner has nothing to do with it (see spawn_extension_agent).
    if runner_status() {
        return Ok(0);
    }
    let mut env = vec![
        ("FEZ_AGENT_PERSONA".to_string(), persona.clone()),
        ("FEZ_AGENT_CHANNELS".to_string(), channels.join(",")),
        ("FEZ_AGENT_OWNER".to_string(), owner),
        ("FEZ_RELAY".to_string(), relays),
    ];
    if let Some(r) = &repo {
        env.push(("FEZ_AGENT_REPO".to_string(), r.clone()));
        if let Some(b) = &base_branch {
            env.push(("FEZ_AGENT_BASE_BRANCH".to_string(), b.clone()));
        }
    }
    spawn_tracked_process(persona, "fez-agent", env, channels, repo, base_branch)
}

/// Run a binary an extension shipped, as a tracked agent.
///
/// A package's `bin` map is copied to ~/.fez/bin at install, so an extension
/// that ships a daemon already has it on disk — what was missing was any way
/// for its gui part to start it. This is that way, and it is deliberately not
/// about any one extension: the bazaar miner is only its first caller.
///
/// It is handed a NAME, never a secret. The binary resolves the agent's own
/// key from fez's key store exactly as fez-agent does, which is what keeps
/// agent keys out of the desktop entirely.
///
/// Deliberately does NOT defer to a live sentinel. The sentinel owns agent
/// summoning; running a package's own daemon is not summoning, and one that
/// inherited that gate would silently do nothing and report success.
#[tauri::command]
fn spawn_extension_agent(
    extension: String,
    bin: String,
    name: String,
    env: Vec<(String, String)>,
) -> Result<u32, String> {
    // Scoped to THIS bin: "drift" the chat agent must not block sending
    // "drift" the miner — one name, two domains, two processes.
    if agent_is_alive_bin(&name, Some(&bin)) {
        return Err(format!("{name} is already running — recall it first"));
    }
    let manifest = fez_home().ok().and_then(|home| package_install::installed_manifest(&extension, &home));
    extension_may_spawn(&settings_value(), manifest.as_ref(), &extension, &bin)?;
    spawn_tracked_process(name, &bin, checked_env(env)?, vec![], None, None)
}

/// ~/.fez/settings.json as a value, or {} — the same file install_package
/// wrote the grants and bin names into.
fn settings_value() -> serde_json::Value {
    fez_home()
        .ok()
        .and_then(|h| std::fs::read_to_string(h.join("settings.json")).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Whether `extension` may start `bin`: the `processes` grant from
/// settings.json, the `bin` claim from the package's own manifest.
///
/// `extension` arrives from the webview and is NOT trustworthy — a gui part
/// runs in the page and can invoke this command directly, naming whichever
/// extension it likes. Both checks therefore live here rather than in the
/// loader that hands out the capability. The named extension must itself hold
/// `processes` — that's the user's grant, and settings.json is where it
/// belongs. But whether it SHIPPED `bin` is not a grant anyone makes; it's a
/// fact about the package on disk, so it's read from `manifest` (the
/// package's own `package.json`, loaded by the caller via
/// `installed_manifest`) rather than from a settings cache anyone could
/// hand-edit. Claiming to be someone else buys nothing that extension could
/// not already do. What no caller can reach, whatever it claims to be, is a
/// binary no installed package's manifest lists.
fn extension_may_spawn(
    settings: &serde_json::Value,
    manifest: Option<&serde_json::Value>,
    extension: &str,
    bin: &str,
) -> Result<(), String> {
    let holds_processes = settings
        .pointer("/extensionPermissions")
        .and_then(|v| v.get(extension))
        .and_then(|v| v.as_array())
        .is_some_and(|a| a.iter().any(|p| p.as_str() == Some("processes")));
    if !holds_processes {
        return Err(format!("{extension} was not granted `processes`"));
    }
    let manifest = manifest.ok_or_else(|| format!("{extension} has no installed package"))?;
    // A bin map KEY is attacker-controlled JSON, stored verbatim from the
    // package's own package.json — presence in the map is not enough. It
    // must also be a bare filename (package_install::safe_bin_name), the
    // same rule install applies before materializing bins: PathBuf::join
    // silently discards the base on an absolute key and walks out of
    // ~/.fez/bin on a traversal one, so an unchecked "declared" is a spawn
    // primitive for any path on disk.
    let shipped_it = package_install::safe_bin_name(bin)
        && manifest.get("bin").and_then(|v| v.as_object()).is_some_and(|m| m.contains_key(bin));
    if !shipped_it {
        return Err(format!("{extension}'s package does not ship a bin called {bin}"));
    }
    Ok(())
}

/// Environment names that change how a process loads code rather than what it
/// does. The extension supplies env for its own binary, so this is not about
/// protecting it from itself: the spawned process inherits the desktop's
/// environment, and these turn "start my daemon" into "run other code inside
/// it". PATH is here for the same reason one level down — the daemon's own
/// subprocesses resolve through it.
const ENV_LOADER_VARS: [&str; 4] = ["LD_", "DYLD_", "NODE_OPTIONS", "BUN_"];

fn checked_env(env: Vec<(String, String)>) -> Result<Vec<(String, String)>, String> {
    for (k, _) in &env {
        if k.is_empty() || k.contains('=') || k.contains('\0') {
            return Err(format!("not an environment name: {k}"));
        }
        let upper = k.to_ascii_uppercase();
        if upper == "PATH" || ENV_LOADER_VARS.iter().any(|p| upper.starts_with(p)) {
            return Err(format!("{k} changes how the process loads code, not what it does"));
        }
    }
    Ok(env)
}

/// THE spawn primitive: validation, env, detached spawn, reap thread, and the
/// pid registry, in one place. Every policy caller goes through here — nothing
/// reaches Command::spawn directly, which is the point.
///
/// `bin` names a file in ~/.fez/bin rather than a path, so a package that
/// ships an executable can be spawned without the desktop knowing anything
/// about it beyond its name.
fn spawn_tracked_process(
    name: String,
    bin: &str,
    env: Vec<(String, String)>,
    channels: Vec<String>,
    repo: Option<String>,
    base_branch: Option<String>,
) -> Result<u32, String> {
    // The name becomes a registry key and a log FILENAME, so it is validated
    // here — in the primitive — where no caller can skip it.
    if !valid_persona_name(&name) {
        return Err(format!("invalid name: {name}"));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let bin_path = std::path::PathBuf::from(&home).join(".fez").join("bin").join(bin);
    if !bin_path.exists() {
        return Err(format!("{bin} isn't installed — nothing at ~/.fez/bin/{bin}"));
    }
    let log_dir = std::path::PathBuf::from(&home).join(".fez").join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("logs dir: {e}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(format!("{name}.log")))
        .map_err(|e| format!("log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| format!("log: {e}"))?;
    let mut cmd = Command::new(&bin_path);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdout(log).stderr(log_err);
    let mut child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;
    let pid = child.id();
    // Reap it: an unwaited Child that exits becomes a ZOMBIE, and `kill -0`
    // succeeds on a zombie — so a dead process kept reading as "alive" until
    // the whole app quit, suppressing the engine's 90s watchdog and making the
    // name unspawnable. This thread's only job is the wait().
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let _guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut rows: Vec<SpawnedAgent> =
        load_agents_registry().into_iter().filter(|r| r.persona != name).collect();
    rows.push(SpawnedAgent {
        persona: name,
        channels,
        repo,
        line: base_branch,
        pid,
        bin: bin.to_string(),
    });
    save_agents_registry(&rows);
    Ok(pid)
}

/// The decision half of kill_agent, split from disk and signals so the rule
/// is testable. Three rules: the signal is gated on the row's OWN bin — the
/// registry holds more than fez-agent now (extension bins like
/// fez-bazaar-miner), and a name-check against "fez-agent" let a live miner
/// dodge the kill while its row was deleted, orphaning it. A live process
/// that REFUSED the signal keeps its row, because deleting it would hide a
/// process we failed to stop and invite a double-spawn on top of it. And a
/// caller that says WHICH bin it means can only ever reach its own row —
/// one name can live in two domains ("drift" the chat agent and "drift"
/// the miner profile), and an unscoped kill from the bazaar panel found
/// the chat agent's row, passed its correct bin check, and killed the
/// workspace agent instead of the miner.
pub(crate) fn kill_decision(
    rows: Vec<SpawnedAgent>,
    persona: &str,
    bin: Option<&str>,
    runs: impl Fn(&SpawnedAgent) -> bool,
    mut signal: impl FnMut(u32) -> bool,
) -> (bool, Option<Vec<SpawnedAgent>>) {
    let matches = |r: &SpawnedAgent| r.persona == persona && bin.is_none_or(|b| r.bin == b);
    let Some(row) = rows.iter().find(|r| matches(r)) else {
        return (false, None);
    };
    // Never signal a pid whose command doesn't match — a reused pid across
    // a reboot belongs to some unrelated process, and a bare kill -0 (or
    // worse, a real kill) can't tell the difference.
    let alive = runs(row);
    let killed = alive && signal(row.pid);
    if alive && !killed {
        return (false, None);
    }
    (killed, Some(rows.into_iter().filter(|r| !matches(r)).collect()))
}

#[tauri::command]
fn kill_agent(persona: String, bin: Option<String>) -> Result<bool, String> {
    let _guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (killed, rest) = kill_decision(
        load_agents_registry(),
        &persona,
        bin.as_deref(),
        |r| pid_runs_bin(r.pid, &r.bin),
        |pid| {
            std::process::Command::new("/bin/kill")
                .arg(pid.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        },
    );
    if let Some(rest) = rest {
        save_agents_registry(&rest);
    }
    Ok(killed)
}

/// Alive if EITHER our own registry says so (name-checked pid, not a
/// bare kill -0 — see pid_runs_bin) OR a sentinel-spawned process for
/// this persona exists (see sentinel_agent_alive). The second check is
/// the reverse split-brain fix: a dead sentinel's detached agents keep
/// running with nothing in the desktop's registry, and without this the
/// desktop can't tell them apart from "nothing is running" and
/// double-spawns on top of them.
#[tauri::command]
fn agent_alive(persona: String, bin: Option<String>) -> bool {
    agent_is_alive_bin(&persona, bin.as_deref())
}

/// Crate-internal liveness (the command above is just its Tauri face) —
/// registry pid (name-checked) OR a sentinel-style process for the persona.
pub(crate) fn agent_is_alive(persona: &str) -> bool {
    agent_is_alive_bin(persona, None)
}

/// Liveness, optionally scoped to one binary. One persona name can live in
/// two domains ("drift" the chat agent and "drift" the miner), and a caller
/// asking "is MY drift running" must not get the other one's yes. The
/// sentinel spawns only fez-agent bodies, so its processes count only when
/// that is the bin being asked about (or no bin was named).
pub(crate) fn agent_is_alive_bin(persona: &str, bin: Option<&str>) -> bool {
    if !valid_persona_name(persona) {
        return false;
    }
    let registry_alive = load_agents_registry()
        .iter()
        .any(|r| r.persona == persona && bin.is_none_or(|b| r.bin == b) && pid_runs_bin(r.pid, &r.bin));
    registry_alive || (bin.is_none_or(|b| b == "fez-agent") && sentinel_agent_alive(persona))
}

#[tauri::command]
fn spawned_agents() -> Vec<SpawnedAgent> {
    load_agents_registry()
}

fn copy_agent_files(src: &std::path::Path, bin: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin).map_err(|e| format!("mkdir {}: {e}", bin.display()))?;
    // A bun-compiled claude-agent-acp shipped briefly and was BROKEN —
    // its SDK loads dynamically and escaped the bundle. The adapter now
    // installs via the managed node runtime (managed_node.rs); delete
    // the dead binary so it can't shadow the working one.
    let _ = std::fs::remove_file(bin.join("claude-agent-acp"));
    // fez-relay and the services are optional: dev builds without bun
    // don't produce them, and the app degrades. pi/pi-acp stay required.
    for (name, required) in [
        ("pi", true),
        ("pi-acp", true),
        ("fez-relay", false),
        ("fez-sentinel", false),
        ("fez-agent", false),
        ("fez-mcp", false),
    ] {
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
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "fez-check-updates" {
                use tauri::Emitter;
                // The webview owns the updater flow (plugin JS API + toasts);
                // the native menu just rings the bell.
                let _ = app.emit("fez-check-updates", ());
            }
        })
        .setup(|app| {
            // macOS gets the standard "Check for Updates…" in the app menu,
            // right under About — the default menu with one item inserted.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let handle = app.handle();
                let menu = Menu::default(handle)?;
                let check =
                    MenuItem::with_id(handle, "fez-check-updates", "Check for Updates…", true, None::<&str>)?;
                if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                    app_menu.insert(&check, 1)?;
                }
                app.set_menu(menu)?;
            }
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
            // Task 7: an install from before the package-dir layout has no
            // packages/<name>/ at all — just flat files and settings.json
            // facts. Reconstruct one per name on first boot after upgrade;
            // once that succeeds, extensionBins/extensionVersions are dead
            // weight (the package dir is now the source of truth for both),
            // so drop them here — settings-mutation is this hook's job, not
            // migrate_flat_installs's.
            std::thread::spawn(|| {
                let Ok(home) = fez_home() else { return };
                let raw = std::fs::read_to_string(home.join("settings.json")).unwrap_or_else(|_| "{}".to_string());
                let settings: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
                match package_migrate::migrate_flat_installs(&home, &settings) {
                    Ok(log) => {
                        for line in &log {
                            println!("migrate: {line}");
                        }
                        if let Err(e) = update_settings(|json| {
                            if let Some(obj) = json.as_object_mut() {
                                obj.remove("extensionBins");
                                obj.remove("extensionVersions");
                            }
                        }) {
                            eprintln!("migrate: couldn't clear legacy settings: {e}");
                        }
                    }
                    Err(e) => eprintln!("migrate_flat_installs: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![stage_artifact, release_artifact, get_pubkey, sign_event, nip44_encrypt, nip44_decrypt, dm_wrap_all, dm_unwrap, get_identity, set_identity, write_persona, list_personas, read_persona, update_persona, rename_persona, delete_persona, list_gui_extensions, extension_storage_read, extension_storage_write, list_local_extensions, list_installed_skills, read_extension_grants, list_persona_drafts, read_persona_draft, approve_persona_draft, reject_persona_draft, write_persona_draft, read_skills, write_skill, remove_skill, set_skill_secret, has_skill_secret, read_bench_proposals, decide_bench_proposal, read_keymap, write_keymap, install_package, remove_extension, read_extension_versions, latest_version, package_info, export_tool, wire_chutes_pi, wire_provider_pi, provider_key_present, detect_harnesses, claude_brain_status, ensure_claude_adapter, ensure_local_relay, local_relay_status, write_relays, write_media_server, read_media_server, runner_status, spawn_agent, kill_agent, agent_alive, spawned_agents, managed_agents::start_managed_agent, spawn_extension_agent, inspect_git_package, install_git_package])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Agents are DETACHED and deliberately outlive the window —
            // the fleet thesis (an agent mid-task must not die because a
            // window closed). Stopping one is explicit: kill_agent.
        });
}

/// The fez host version `fez.minFezVersion` is enforced against — a
/// mirror of FEZ_VERSION in src/extensions/host-compat.ts. The
/// host-compat eval in fez-evals keeps the two equal; bump them together.
const FEZ_VERSION: &str = "0.2.0";

/// Mirrors minFezVersionError in host-compat.ts: None = allow. Absent
/// field means no claim; an unparseable requirement refuses too — a
/// package declaring garbage is asking for a check we cannot perform.
fn min_fez_version_error(required: Option<&str>, host: &str) -> Option<String> {
    let required = required?;
    let parts: Vec<&str> = required.split('.').collect();
    let well_formed = (1..=3).contains(&parts.len())
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !well_formed {
        return Some(format!(
            "declares minFezVersion \"{required}\", which is not an x.y.z version — refusing to guess"
        ));
    }
    let nums = |v: &str| -> [u64; 3] {
        let mut out = [0u64; 3];
        for (i, p) in v.split('.').take(3).enumerate() {
            out[i] = p.parse().unwrap_or(0);
        }
        out
    };
    if nums(host) < nums(required) {
        return Some(format!("needs fez ≥ {required}, you have {host} — update fez and retry"));
    }
    None
}

#[cfg(test)]
mod harness_detect_tests {
    use super::binary_in_dirs;

    #[test]
    fn executable_counts_and_exec_bit_matters() {
        let dir = std::env::temp_dir().join(format!("fez-detect-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("claude");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o644)).unwrap();
        let dirs = vec![dir.to_string_lossy().to_string()];
        assert!(!binary_in_dirs("claude", &dirs), "non-executable must not count");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(binary_in_dirs("claude", &dirs));
        assert!(!binary_in_dirs("codex", &dirs));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod relay_port_tests {
    use super::{choose_relay_port, PortState};

    #[test]
    fn free_desired_port_is_spawned_on() {
        let got = choose_relay_port(7777, |_| PortState::Free);
        assert_eq!(got, Some((7777, false)));
    }

    #[test]
    fn our_relay_already_answering_is_adopted_not_respawned() {
        let got = choose_relay_port(7777, |p| if p == 7777 { PortState::Ours } else { PortState::Free });
        assert_eq!(got, Some((7777, true)));
    }

    #[test]
    fn foreign_relay_on_the_port_is_never_adopted() {
        // Another macOS user's session already has THEIR fez relay on
        // 7777 — localhost ports are machine-global, and adopting it
        // walked a fresh test account straight into their workspace.
        let got = choose_relay_port(7777, |p| if p == 7777 { PortState::Foreign } else { PortState::Free });
        assert_eq!(got, Some((7778, false)));
    }

    #[test]
    fn scan_gives_up_rather_than_guessing() {
        assert_eq!(choose_relay_port(7777, |_| PortState::Foreign), None);
    }
}

#[cfg(test)]
mod pid_tests {
    use super::pid_alive_named;
    use std::io::Write;

    #[test]
    fn matching_name_counts_as_alive() {
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let dir = std::env::temp_dir().join(format!("fez-pid-test-{}", child.id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("relay.pid");
        write!(std::fs::File::create(&pidfile).unwrap(), "{}", child.id()).unwrap();
        assert_eq!(pid_alive_named(&pidfile, "sleep"), Some(child.id()));
        // A reused PID belonging to some OTHER program must not count —
        // this is the stale-pidfile-after-reboot bug.
        assert_eq!(pid_alive_named(&pidfile, "fez-relay"), None);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dead_pid_and_missing_file_are_not_alive() {
        let dir = std::env::temp_dir().join("fez-pid-test-static");
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("relay.pid");
        std::fs::write(&pidfile, "99999999").unwrap();
        assert_eq!(pid_alive_named(&pidfile, "fez-relay"), None);
        assert_eq!(pid_alive_named(&dir.join("nope.pid"), "fez-relay"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod host_compat_tests {
    use super::min_fez_version_error;

    #[test]
    fn absent_field_means_no_claim() {
        assert_eq!(min_fez_version_error(None, "0.2.0"), None);
    }

    #[test]
    fn older_host_refuses_naming_both_versions() {
        let err = min_fez_version_error(Some("0.3.0"), "0.2.0").expect("must refuse");
        assert!(err.contains("0.3.0") && err.contains("0.2.0"), "{err}");
        assert!(err.contains("update fez"), "{err}");
    }

    #[test]
    fn equal_and_newer_hosts_allow() {
        assert_eq!(min_fez_version_error(Some("0.2.0"), "0.2.0"), None);
        assert_eq!(min_fez_version_error(Some("0.2.0"), "0.10.1"), None);
    }

    #[test]
    fn missing_parts_are_zero() {
        assert_eq!(min_fez_version_error(Some("0.2"), "0.2.0"), None);
        assert!(min_fez_version_error(Some("1"), "0.9.9").is_some());
    }

    #[test]
    fn numeric_not_lexicographic() {
        // "0.10.0" > "0.9.0" numerically; a string compare gets this wrong
        assert_eq!(min_fez_version_error(Some("0.9.0"), "0.10.0"), None);
    }

    #[test]
    fn garbage_requirement_refuses_to_guess() {
        for bad in ["^0.2.0", "0.2.x", "two", "0..2", "", "1.2.3.4"] {
            let err = min_fez_version_error(Some(bad), "0.2.0").expect("must refuse");
            assert!(err.contains("refusing to guess"), "{bad}: {err}");
        }
    }
}

#[cfg(test)]
mod provider_tests {
    use super::{provider_spec, local_provider_id};
    #[test]
    fn table_has_the_v1_four() {
        for p in ["chutes", "anthropic", "openai", "openrouter"] {
            assert!(provider_spec(p).is_some(), "missing provider {p}");
        }
        assert!(provider_spec("nope").is_none());
    }
    #[test]
    fn chutes_id_matches_the_legacy_constant() {
        // sha256("https://llm.chutes.ai/v1")[..10] — pinned by the existing wiring.
        assert_eq!(local_provider_id("https://llm.chutes.ai/v1"), "56105ece7a");
    }
}

#[cfg(test)]
mod self_tag_tests {
    use super::{build_event, parse_tags};

    /// A reminder is addressed to ITSELF: `["p", <own pubkey>]`. nostr-rs
    /// strips such a tag during `build` unless self-tagging is allowed
    /// ("removes any `p` tags that match the author's public key"), so the
    /// event reached the relay untagged and every `#p` query missed it —
    /// silently, because a stripped tag is not an error anywhere.
    ///
    /// A signer must sign what it was asked to sign. This pins that.
    #[test]
    fn a_self_addressed_p_tag_survives_signing() {
        let keys = nostr::Keys::generate();
        let me = keys.public_key().to_hex();
        let event = build_event(
            40007,
            "ciphertext".to_string(),
            parse_tags(vec![vec!["p".to_string(), me.clone()]]).unwrap(),
            None,
            &keys,
        )
        .expect("sign");
        assert_eq!(event.tags.len(), 1, "the self `p` tag was stripped: {:?}", event.tags);
    }

    /// The ordinary case must keep working: a `p` tag naming SOMEONE ELSE
    /// was never at risk, and this is what proved the signer innocent for
    /// too long while reminders were broken.
    #[test]
    fn a_p_tag_naming_someone_else_also_survives() {
        let keys = nostr::Keys::generate();
        let other = nostr::Keys::generate().public_key().to_hex();
        let event = build_event(
            47006,
            String::new(),
            parse_tags(vec![vec!["p".to_string(), other]]).unwrap(),
            None,
            &keys,
        )
        .expect("sign");
        assert_eq!(event.tags.len(), 1);
    }
}
