use nostr::JsonUtil as _;
#[cfg(target_os = "macos")]
mod always_on;
mod bounded_command;
mod bundled_extensions;
mod desktop_runtime;
mod git_install;
mod isolated_panel;
#[cfg(feature = "native-browser")]
pub mod native_surfaces;
#[cfg(all(target_os = "macos", feature = "cef-prototype"))]
#[path = "../../../fez-browser/prototype-cef/native.rs"]
mod cef_prototype;
mod managed_agents;
mod managed_node;
mod notifications;
mod package_install;
mod package_migrate;
mod workspace_pins;
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
/// Serialize lifecycle decisions before process creation, through replacement and shutdown.
static AGENTS_REGISTRY_LOCK: Mutex<()> = Mutex::new(());
/// Why a tracked process last died, keyed "name\u{0}bin" — the row's
/// feedback when the send button flips back. Cleared on respawn.
static LAST_EXITS: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);
/// Set once at setup so background threads (the process reaper) can push
/// events to the webview — feedback the moment something dies, no polling.
static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
/// Stops the user asked for, by PID — the reaper consumes an entry
/// to keep a deliberate recall from toasting as a death.
static EXPECTED_STOPS: Mutex<Option<std::collections::HashSet<u32>>> = Mutex::new(None);
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

/// Explicit export for onboarding and backup. Still reachable from the
/// shared webview: this command is not an extension isolation boundary.
#[tauri::command]
fn get_identity(account: Option<String>) -> Result<String, String> {
    let account = account.unwrap_or_else(|| "default".to_string());
    read_identity(&account)?
        .ok_or_else(|| format!("no fez identity in the keychain for account \"{account}\""))
}

// Absence is data, access failure is an error. Key creation must never
// infer permission to replace an identity from a failed keychain read.
fn read_identity(account: &str) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "fez-keys",
            "-a",
            account,
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
            return Ok(None);
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
    Ok(Some(hex))
}

// ── key custody ─────────────────────────────────────────────────────
// Boot, messaging and agent setup use pubkeys and native crypto.
// Onboarding and backup still export keys through get_identity above.

/// Keys per account, loaded from the keychain once per launch — DM
/// history decrypt would otherwise spawn `security` per event.
static IDENTITY_KEYS: Mutex<Option<std::collections::HashMap<String, nostr::Keys>>> =
    Mutex::new(None);

fn load_keys(account: Option<String>) -> Result<nostr::Keys, String> {
    let name = account.clone().unwrap_or_else(|| "default".to_string());
    // Serialize cache fills with creation/replacement so a slow old read
    // cannot repopulate the cache after a successful restore.
    // ponytail: one lock across keychain IO; per-account locks if this contends.
    let mut guard = IDENTITY_KEYS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(keys) = guard.as_ref().and_then(|m| m.get(&name)) {
        return Ok(keys.clone());
    }
    let hex = get_identity(account)?;
    let keys = nostr::Keys::parse(&hex).map_err(|e| format!("bad identity key: {e}"))?;
    guard.get_or_insert_with(Default::default).insert(name, keys.clone());
    Ok(keys)
}

/// The boot call: who am I — and nothing else crosses the bridge.
#[tauri::command]
fn get_pubkey(account: Option<String>) -> Result<String, String> {
    Ok(load_keys(account)?.public_key().to_hex())
}

/// Prepare a local agent without handing its private key to JavaScript.
#[tauri::command]
fn ensure_agent_identity(name: String) -> Result<String, String> {
    if !valid_persona_name(&name) {
        return Err("invalid persona name".to_string());
    }
    let account = format!("agent:{name}");
    let mut guard = IDENTITY_KEYS.lock().unwrap_or_else(|p| p.into_inner());
    let cache = guard.get_or_insert_with(Default::default);
    if let Some(keys) = cache.get(&account) {
        return Ok(keys.public_key().to_hex());
    }
    let keys = ensure_identity_key(read_identity(&account), |hex| store_identity(&account, hex, false))?;
    let pubkey = keys.public_key().to_hex();
    cache.insert(account, keys);
    Ok(pubkey)
}

fn ensure_identity_key(
    existing: Result<Option<String>, String>,
    save: impl FnOnce(&str) -> Result<(), String>,
) -> Result<nostr::Keys, String> {
    match existing? {
        Some(hex) => nostr::Keys::parse(&hex).map_err(|e| format!("bad identity key: {e}")),
        None => {
            let keys = nostr::Keys::generate();
            save(&keys.secret_key().to_secret_hex())?;
            Ok(keys)
        }
    }
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
/// the onboarding writer. Refuses to overwrite by default: an existing
/// identity is never SILENTLY replaced from the GUI. `replace: true` is
/// the explicit exception for restore-from-backup and device pairing —
/// without it, one click on "get started" (which mints on the first
/// screen) permanently locked both doors: restore dead-ended on this
/// very error, and pairing completed the SAS ceremony then threw the
/// transferred key away. A minutes-old mint that owns nothing is the
/// user's to replace with the identity they actually meant.
/// ponytail: if a workspace was already claimed this run, replacing
/// leaves it owned by the discarded key — re-claim flow if that bites.
#[tauri::command]
fn set_identity(account: Option<String>, hex: String, replace: Option<bool>) -> Result<(), String> {
    let account = account.unwrap_or_else(|| "default".to_string());
    let mut guard = IDENTITY_KEYS.lock().unwrap_or_else(|p| p.into_inner());
    store_identity(&account, &hex, replace == Some(true))?;
    if let Some(cache) = guard.as_mut() {
        cache.remove(&account);
    }
    Ok(())
}

fn store_identity(account: &str, hex: &str, replace: bool) -> Result<(), String> {
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("not a 64-hex key".to_string());
    }
    nostr::Keys::parse(hex).map_err(|e| format!("bad identity key: {e}"))?;
    if !replace {
        // The guard must fail CLOSED: a denied keychain prompt makes
        // get_identity error exactly like an absent identity, and
        // treating "can't read" as "doesn't exist" made prompt-denial
        // the one path that could clobber the root identity (-U is an
        // update). Only the not-found error means it's safe to write.
        match read_identity(account) {
            Ok(Some(_)) => return Err(format!("account \"{account}\" already holds an identity")),
            Ok(None) => {} // genuinely absent — mint away
            Err(e) => return Err(format!("can't tell whether an identity already exists — {e}")),
        }
    }
    let mut command = Command::new("security");
    command.args([
        "add-generic-password",
        "-s",
        "fez-keys",
        "-a",
        account,
        "-w",
        hex,
    ]);
    // Without -U the keychain also refuses a concurrent CLI's new key;
    // the read-before-write guard alone cannot make creation atomic.
    if replace {
        command.arg("-U");
    }
    let status = command
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

/// Unix-seconds mtime of a persona file — the "was it edited since its
/// body spawned?" half of the profile's restart hint.
#[tauri::command]
fn persona_mtime(name: String) -> Result<u64, String> {
    if !valid_persona_name(&name) {
        return Err("bad persona name".to_string());
    }
    std::fs::metadata(persona_dir()?.join(format!("{name}.md")))
        .and_then(|m| m.modified())
        .map_err(|e| format!("couldn't stat persona \"{name}\": {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| e.to_string())
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
/// Delete a keychain secret — how a Connection is disconnected (the
/// OAuth blob at "<skill>.OAUTH" is forgotten). Missing item is success:
/// disconnect is idempotent.
#[tauri::command]
fn delete_skill_secret(skill: String, key: String) -> Result<(), String> {
    if !valid_secret_name(&skill) || !valid_secret_name(&key) {
        return Err("bad skill/key name".to_string());
    }
    let account = format!("{skill}.{key}");
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", "fez-skill-env", "-a", &account])
        .status();
    Ok(())
}

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
    keychain_presence(output.status.code())
}

fn keychain_presence(code: Option<i32>) -> Result<bool, String> {
    match code {
        Some(0) => Ok(true),
        Some(44) => Ok(false), // errSecItemNotFound; a locked/denied keychain is not "disconnected".
        _ => Err("keychain access failed".into()),
    }
}

/// GUI extension parts installed by `fez install`/`fez link`
/// (~/.fez/packages/<name>/, per each manifest's `fez.parts.gui`). The
/// webview imports each as an ES module and calls its activate(api) — the
/// GUI's version of the TUI's extension loader.
#[tauri::command]
fn list_gui_extensions() -> Result<Vec<(String, String, String, Option<String>, Option<String>, Option<serde_json::Value>, Option<serde_json::Value>)>, String> {
    let home_path = fez_home()?;
    Ok(package_install::gui_parts(&home_path).into_iter().map(|(name, code, styles, runtime)| {
        let source = package_install::installed_manifest(&name, &home_path)
            .and_then(|manifest| manifest.pointer("/fez/settingsSource").and_then(serde_json::Value::as_str)
                .filter(|source| valid_secret_name(source)).map(str::to_owned));
        let contributions = package_install::installed_manifest(&name, &home_path)
            .and_then(|manifest| manifest.pointer("/fez/guiContributions").cloned());
        // A manifest-declared model provider; the GUI drives it through run_extension_bin.
        let model_provider = package_install::installed_manifest(&name, &home_path)
            .and_then(|manifest| manifest.pointer("/fez/modelProvider").cloned());
        (name, code, styles, source, runtime, contributions, model_provider)
    }).collect())
}

/// Legacy main-webview API. Isolated panels use the caller-bound broker.
#[tauri::command]
fn extension_storage_read(name: String) -> Result<String, String> {
    isolated_panel::read_storage(&fez_home()?, &name).map(|value| value.to_string())
}

#[tauri::command]
fn extension_storage_write(name: String, key: String, value: String) -> Result<(), String> {
    let value = serde_json::from_str(&value).map_err(|e| format!("invalid value json: {e}"))?;
    isolated_panel::write_preference(&fez_home()?, &name, &key, value)
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
    package_install::write_atomic(&path, text.as_bytes()).map_err(|e| format!("couldn't write settings.json: {e}"))
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

fn harness_path(cmd: &str) -> Option<std::path::PathBuf> {
    harness_search_dirs().into_iter().find(|dir| binary_in_dirs(cmd, std::slice::from_ref(dir)))
        .map(|dir| std::path::Path::new(&dir).join(cmd))
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
        "/Applications/Codex.app/Contents/Resources".into(),
        "/Applications/ChatGPT.app/Contents/Resources".into(),
        format!("{home}/Applications/Codex.app/Contents/Resources"),
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
/// Auth probes share the bounded runner: noisy output and inherited pipes
/// must not stall onboarding or make a truncated result look authoritative.
fn probe_claude_auth(path: &std::path::Path) -> bool {
    let Ok(output) = bounded_command::run(
        Command::new(path).args(["auth", "status"]).env("PATH", subprocess_path_env()),
        std::time::Duration::from_secs(10),
        1024 * 1024,
    ) else { return false };
    std::str::from_utf8(&output.stdout).ok().and_then(managed_node::parse_claude_auth)
        .or_else(|| std::str::from_utf8(&output.stderr).ok().and_then(managed_node::parse_claude_auth))
        .unwrap_or(false)
}

/// async, deliberately: a sync Tauri v2 command runs ON THE MAIN THREAD,
/// and this one shells out to `claude auth status`. Sync, it froze the
/// event loop for the probe's whole runtime — entering the harness step
/// beachballed the window before the CHECKING pill could even paint.
#[tauri::command]
async fn claude_brain_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let claude = harness_path("claude");
        let installed = claude.is_some();
        let authed = claude.as_deref().map(probe_claude_auth).unwrap_or(false);
        serde_json::json!({
            "installed": installed,
            "authed": authed,
            "adapterReady": managed_node::adapter_ready(),
        })
        .to_string()
    })
    .await
    .map_err(|e| format!("status probe panicked: {e}"))
}

/// Probe sign-in without reading or returning the user's credential files.
#[tauri::command]
async fn codex_brain_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let codex = harness_path("codex");
        let authed = codex.as_ref().map(|path| {
            bounded_command::run(Command::new(path).args(["login", "status"]).env("PATH", subprocess_path_env()),
                std::time::Duration::from_secs(10), 1024 * 1024)
                .map(|out| out.status.success()).unwrap_or(false)
        }).unwrap_or(false);
        serde_json::json!({ "installed": codex.is_some(), "authed": authed,
            "adapterReady": managed_node::local_adapter_ready("codex") }).to_string()
    }).await.map_err(|e| format!("Codex status probe failed: {e}"))
}

#[tauri::command]
async fn ensure_codex_adapter() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| managed_node::ensure_adapter("codex"))
        .await.map_err(|e| format!("Codex setup failed: {e}"))?
}

/// Provision the private node runtime + the Claude ACP adapter — the
/// managed-npm decision (see managed_node.rs). First run downloads and
/// takes tens of seconds; the brain card owns the spinner.
/// Factory reset — the desktop twin of `fez reset --factory` (the list
/// of what gets wiped is defined in src/identity/reset.ts; keep this in
/// step, it cannot import that). Kills what fez spawned, sweeps the fez
/// keychain services (identity, agent keys, skill secrets), removes
/// ~/.fez, then relaunches straight into onboarding. The webview's
/// localStorage (onboarding stamp/snapshot, relay set, name) is cleared
/// by the CALLER before invoking — WebKit owns that store while the app
/// runs, so the page clears its own storage and this side touches only
/// what it owns.
#[tauri::command]
async fn factory_reset(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        // Children first — an agent or relay alive during the wipe
        // re-writes state on exit and half-undoes the reset.
        for sub in ["bin", "relay"] {
            let _ = Command::new("/usr/bin/pkill")
                .args(["-f", &format!("{home}/.fez/{sub}")])
                .status();
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for service in ["fez-keys", "fez-skill-env", "fez-wallet"] {
            // One entry per account; `security` deletes one match per
            // call — loop until the service is empty.
            loop {
                let ok = Command::new("security")
                    .args(["delete-generic-password", "-s", service])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if !ok {
                    break;
                }
            }
        }
        let _ = std::fs::remove_dir_all(std::path::Path::new(&home).join(".fez"));
    })
    .await
    .map_err(|e| format!("factory reset task panicked: {e}"))?;
    app.restart();
}

/// async for the same main-thread reason as claude_brain_status, and
/// with far higher stakes: this downloads a ~50MB node runtime and runs
/// `npm install`. As a sync command it parked ALL of that on the main
/// thread — the click appeared to do nothing (React never re-rendered
/// the SETTING UP state), the window beachballed, and on a slow network
/// macOS reported the app as not responding. The managed_node doc
/// comment always said "called from an async Tauri command"; now true.
#[tauri::command]
async fn ensure_claude_adapter() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(managed_node::ensure_claude_adapter)
        .await
        .map_err(|e| format!("setup task panicked: {e}"))?
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
    let mut map = serde_json::Map::new();
    map.insert("pi".into(), serde_json::json!(harness_installed("pi-acp")));
    for agent in managed_node::local_agents() {
        map.insert(agent["id"].as_str().unwrap().into(),
            serde_json::json!(harness_installed(agent["cli"].as_str().unwrap())));
    }
    let map = serde_json::Value::Object(map);
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

/// The v1 provider table. Adding a provider is adding a row here (plus its
/// mirrors in providers.ts and ModelPicker.tsx); wire_provider_pi and
/// provider_key_present are both fully data-driven off it.
fn provider_spec(id: &str) -> Option<&'static ProviderSpec> {
    const PROVIDERS: &[ProviderSpec] = &[
        ProviderSpec { id: "chutes", name: "Chutes", base_url: "https://llm.chutes.ai/v1", key_name: "CHUTES_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "anthropic", name: "Anthropic", base_url: "https://api.anthropic.com/v1", key_name: "ANTHROPIC_API_KEY", auth: ProviderAuth::XApiKey },
        ProviderSpec { id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", key_name: "OPENAI_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_name: "OPENROUTER_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "gm", name: "GM", base_url: "https://api.saygm.com/v1", key_name: "GM_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "actual", name: "Actual", base_url: "https://api.actual.inc/v1", key_name: "ACTUAL_API_KEY", auth: ProviderAuth::Bearer },
        ProviderSpec { id: "engy", name: "Engy", base_url: "https://api.engy.ai/v1", key_name: "ENGY_API_KEY", auth: ProviderAuth::Bearer },
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
        .map(|a| {
            a.iter()
                // A catalog may carry models pi can't call: GM lists every API
                // shape and flags sold-out offers — keep chat.completions rows
                // that aren't explicitly unavailable, pass shapeless rows through.
                .filter(|m| m.get("api_shapes").and_then(|v| v.as_array()).map_or(true, |sh| sh.iter().any(|x| x.as_str() == Some("chat.completions"))))
                .filter(|m| m.get("available").and_then(|v| v.as_bool()) != Some(false))
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err(format!("{} returned no models", spec.name));
    }

    // Write the file pi ACTUALLY reads: ~/.pi/agent/models.json, schema
    // {providers:{<id>:{name,baseUrl,api,apiKey,models:[...]}}} — verified
    // empirically against the bundled pi's own validator (2026-09-05; the
    // local-models.json path above predates that discovery and is kept only
    // so older personas keep resolving). Model entries carry pragmatic
    // defaults: cost zeros (display-only), a generous context window, and
    // reasoning=true so thinking models get output headroom.
    let api_shape = match spec.auth {
        ProviderAuth::XApiKey => "anthropic-messages",
        ProviderAuth::Bearer => "openai-completions",
    };
    let models_cfg = std::path::Path::new(&home).join(".pi").join("agent").join("models.json");
    let mut doc: serde_json::Value = std::fs::read_to_string(&models_cfg)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({ "providers": {} }));
    if !doc.is_object() { doc = serde_json::json!({ "providers": {} }); }
    let entries: Vec<serde_json::Value> = models
        .iter()
        .map(|id| serde_json::json!({
            "id": id, "name": id, "reasoning": true, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 131072, "maxTokens": 16384,
        }))
        .collect();
    doc["providers"][spec.id] = serde_json::json!({
        "name": spec.name, "baseUrl": spec.base_url, "api": api_shape,
        "apiKey": key, "models": entries,
    });
    if let Some(parent) = models_cfg.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&models_cfg, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n")
        .map_err(|e| format!("couldn't write pi models.json: {e}"))?;

    Ok(serde_json::json!({ "provider": spec.id, "models": models }).to_string())
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

    finish_install(&name, &tar_bytes, latest)
}

/// Shared tail for every install path (npm registry, git repo): place the
/// tarball's parts into ~/.fez/packages/<base>/, index them into the flat
/// dirs, and record granted permissions + background opt-in in
/// settings.json. See package_install for the on-disk layout (shared with
/// the CLI's PackageManager).
fn finish_install(name: &str, tar_bytes: &[u8], version: &str) -> Result<String, String> {
    let pkg_bytes = package_install::tar_read(tar_bytes, "package.json").ok_or("no package.json in tarball")?;
    let pkg: serde_json::Value = serde_json::from_slice(&pkg_bytes).map_err(|e| e.to_string())?;
    if let Some(error) = min_fez_version_error(pkg.pointer("/fez/minFezVersion").and_then(|v| v.as_str()), FEZ_VERSION) {
        return Err(format!("{name} {error}"));
    }
    let home = fez_home()?;
    let base = name.rsplit('/').next().unwrap_or(name).trim_start_matches('@');
    git_install::check_replacement(&pkg, package_install::installed_manifest(base, &home).as_ref())?;
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

/// Inspect a scoped GitHub source. Fetching stays off the UI thread;
/// the report's canonical URL preserves the resolved ref/path boundary.
#[tauri::command]
async fn inspect_git_package(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut source = git_install::parse_github_url(&url)?;
        let (tar_bytes, sha) = git_install::fetch_source(&mut source)?;
        let (mut report, npm_tar) = git_install::convert(&tar_bytes, &source, &sha, None)?;
        if let Some(tar) = npm_tar {
            if let Some(bytes) = package_install::tar_read(&tar, "package.json") {
                let pkg: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                if let Some(error) = min_fez_version_error(pkg.pointer("/fez/minFezVersion").and_then(|v| v.as_str()), FEZ_VERSION) {
                    report.refused.push(error);
                }
                let base = report.name.rsplit('/').next().unwrap_or(&report.name).trim_start_matches('@');
                if let Err(error) = git_install::check_replacement(&pkg, package_install::installed_manifest(base, &fez_home()?).as_ref()) {
                    report.refused.push(error);
                }
            }
        }
        let base = report.name.rsplit('/').next().unwrap_or(&report.name).trim_start_matches('@');
        let installed = package_install::installed_manifest(base, &fez_home()?).is_some();
        let mut value = serde_json::to_value(&report).map_err(|e| e.to_string())?;
        let obj = value.as_object_mut().ok_or("bad report")?;
        obj.insert("sha".into(), serde_json::json!(sha));
        obj.insert("url".into(), serde_json::json!(source.url()));
        obj.insert("installed".into(), serde_json::json!(installed));
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Install only the reviewed commit and selected source entries. Importing
/// foreign skills is explicit, and never activates that host's plugin code.
#[tauri::command]
async fn install_git_package(url: String, selected_paths: Option<Vec<String>>, allow_skills_only: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut source = git_install::parse_github_url(&url)?;
        source.require_pinned()?;
        let (tar_bytes, sha) = git_install::fetch_source(&mut source)?;
        let (report, npm_tar) = git_install::convert(&tar_bytes, &source, &sha, selected_paths.as_deref())?;
        if report.kind == "skills" && (allow_skills_only != Some(true) || selected_paths.is_none()) {
            return Err("choose the skills to import and confirm that foreign plugin integrations are not installed".into());
        }
        let Some(npm_tar) = npm_tar else {
            return Err(format!("{} refused: {}", report.name, report.refused.join(", ")));
        };
        let bytes = package_install::tar_read(&npm_tar, "package.json").ok_or("missing package manifest")?;
        let pkg: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
        finish_install(&report.name, &npm_tar, version)
    }).await.map_err(|e| e.to_string())?
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
/// Async + spawn_blocking (like connect_service): a sync command runs on
/// the main thread, and a blocking npm fetch there freezes every other
/// invoke — the gallery stalled seconds on open before this.
#[tauri::command]
async fn package_info(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The latest published version of a package, from the npm registry.
/// Async + spawn_blocking for the same reason as package_info.
#[tauri::command]
async fn latest_version(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
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
/// Every name an install may be recorded under: as given, with the `fez-`
/// prefix, and without it. The gallery strips the prefix before calling
/// remove, while a linked package is recorded under its full name.
fn extension_name_candidates(name: &str) -> Vec<String> {
    let bare = name.trim_start_matches("fez-");
    let mut out: Vec<String> = Vec::new();
    for cand in [name.to_string(), format!("fez-{bare}"), bare.to_string()] {
        if !out.contains(&cand) {
            out.push(cand);
        }
    }
    out
}

/// Forget an extension in settings: its grant, background opt-in, version and
/// skill entry. Returns the bins it installed so their files go too.
fn forget_extension_settings(json: &mut serde_json::Value, name: &str) -> Vec<String> {
    let mut bins_to_remove: Vec<String> = Vec::new();
    let Some(obj) = json.as_object_mut() else { return bins_to_remove };
    for cand in extension_name_candidates(name) {
        let cand = cand.as_str();
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
                    bins_to_remove.extend(list.iter().filter_map(|v| v.as_str().map(String::from)));
                }
            }
        }
    }
    bins_to_remove
}

#[tauri::command]
fn remove_extension(name: String) -> Result<String, String> {
    if name.is_empty() || name.len() > 128 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err("not a valid extension name".to_string());
    }
    let home = fez_home()?;
    let candidates = extension_name_candidates(&name);
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
        for dir in ["gui-extensions", "extensions", "relay-extensions", "workspace-providers", "miners"] {
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
    update_settings(|json| bins_to_remove = forget_extension_settings(json, &name))?;
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
fn install_bundled_agent(app: tauri::AppHandle, src: std::path::PathBuf) {
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
        Err(e) => {
            // stderr goes nowhere a packaged-app user can see — a machine
            // where the copy keeps failing (disk full, unwritable
            // ~/.fez/bin) was indistinguishable from a working one until
            // an agent silently refused to start. The webview toasts it.
            eprintln!("bundled agent install failed ({e}) — will retry next launch");
            use tauri::Emitter;
            let _ = app.emit(
                "agent-install-failed",
                format!("fez's bundled agent couldn't install ({e}) — agents may not start; it retries next launch"),
            );
        }
    }
}

/// Every file the bundle SHIPS is required for a successful install —
/// pi + pi-acp executable always; theme (pi needs it even in --mode
/// rpc) and the image-tools wasm when present, since prepare-pi-agent
/// bundles those only if they exist. Any failure aborts before the
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

#[tauri::command]
fn workspace_owner_pin(id: String, value: Option<String>) -> Result<Option<String>, String> {
    workspace_pins::pin(&fez_home()?.join("workspace-owners"), &id, value.as_deref())
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
            // A failed HTTP probe does NOT mean the port is free: a
            // non-HTTP squatter (or a listener slower than the 500ms
            // budget) errors exactly like a closed port, and binding
            // onto it killed the relay with EADDRINUSE while the
            // 7778+ fallback scan never ran. A bare TCP connect
            // splits the two — buzz's mesh-ingress learned this the
            // hard way (bound-but-busy is not dead).
            Err(_) => match std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                std::time::Duration::from_millis(300),
            ) {
                Ok(_) => PortState::Foreign,
                Err(_) => PortState::Free,
            },
        }
    };

    // Our own relay mid-startup is TCP-bound but not yet answering
    // NIP-11 — the probe would read that as Foreign and scan onward,
    // spawning a SECOND relay one port over. The pidfile (verified by
    // process name) says it's ours booting: hold the remembered port
    // and let the health wait below do its job.
    let pidfile = dir.join("relay.pid");
    let (port, already_ours) = if pid_alive_named(&pidfile, "fez-relay").is_some() {
        (desired_port, false)
    } else {
        choose_relay_port(desired_port, probe).ok_or(
            "every loopback port near 7777 is taken by something that isn't your relay — \
             quit whatever is using them (or restart) and try again",
        )?
    };

    // Persist the CHOSEN port with the identity — a respawn must come back
    // on the same port the client remembers.
    let v = serde_json::json!({ "owner": owner, "name": name, "port": port });
    std::fs::write(&args_file, v.to_string()).map_err(|e| format!("args.json: {e}"))?;

    if !already_ours && pid_alive_named(&pidfile, "fez-relay").is_none() {
        let home = std::env::var("HOME").unwrap_or_default();
        let bin = std::path::PathBuf::from(&home).join(".fez").join("bin").join("fez-relay");
        // First launch races the bundled-binary copy (a detached thread
        // moving ~140MB, fez-relay landing last) — "isn't bundled" was
        // a false statement that steered brand-new users to the invite
        // door. Give the copy a real chance to finish before concluding.
        if !bin.exists() {
            for _ in 0..40 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if bin.exists() {
                    break;
                }
            }
        }
        if !bin.exists() {
            return Err(
                "the bundled fez-relay hasn't finished installing — try again in a moment \
                 (if this keeps happening, reinstall fez)"
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
                // Governed store: without this any pubkey that can reach the
                // port (it binds every interface — the whole LAN) can write
                // into channels. Found live: a stranger key's channel message
                // was accepted; only the agents' author-gate stood behind it.
                // Membership gates h-tagged writes to the roster and h-tagged
                // reads to NIP-42-authed members — both wires already auth.
                "--policy",
                "membership",
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

/// Run the OAuth sign-in for a connectable service (Connections — see
/// src/extensions/connections.ts). The webview can't hold the loopback
/// callback port, so the bundled fez-agent runs the whole flow: it opens
/// the browser, catches the redirect, lands tokens in the keychain, and
/// registers the skill in settings.json. Blocks until the sign-in
/// finishes (minutes at worst), so it runs off the main thread.
#[tauri::command]
async fn connect_service(key: String) -> Result<String, String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad connection key".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        let bin = std::path::PathBuf::from(&home).join(".fez").join("bin").join("fez-agent");
        if !bin.exists() {
            return Err("fez-agent isn't installed yet — relaunch the app to install the bundled runtime".into());
        }
        let out = std::process::Command::new(&bin)
            .args(["connect", &key])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
    /// Unix seconds when this row's process was spawned. The profile
    /// compares it with the persona file's mtime to say "edited since
    /// spawn — restart to pick up changes". Absent on rows written
    /// before the field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spawned_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relays: Option<String>,
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

fn save_agents_registry(rows: &[SpawnedAgent]) -> Result<(), String> {
    let path = agents_registry_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec_pretty(rows).map_err(|e| e.to_string())?)
        .map_err(|e| format!("save agent registry: {e}"))?;
    std::fs::rename(staged, path).map_err(|e| format!("save agent registry: {e}"))
}

fn raw_pid_alive(pid: u32) -> bool {
    pid > 1 && unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Persisted receipts never authorize signalling a process based on a substring.
pub(crate) fn pid_runs_bin(pid: u32, bin: &str) -> bool {
    let Ok(home) = fez_home() else { return false };
    desktop_runtime::pid_runs_path(pid, &home.join("bin").join(bin))
}

fn sentinel_agent_pid(persona: &str) -> Option<u32> {
    if !valid_persona_name(persona) { return None; }
    let pid = std::fs::read_to_string(fez_home().ok()?.join("agents").join(format!("{persona}.pid")))
        .ok()?.trim().parse().ok()?;
    (pid_runs_bin(pid, "fez-agent") && desktop_runtime::legacy_persona_matches(pid, persona)).then_some(pid)
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

/// Spawn the bundled agent runtime for a persona and record
/// its pid. The desktop's half of the summoner — policy lives in the
/// shared SummonEngine on the JS side; this is only mechanics.
#[tauri::command]
async fn spawn_agent(
    persona: String,
    channels: Vec<String>,
    owner: String,
    relays: String,
    repo: Option<String>,
    base_branch: Option<String>,
    manual: Option<bool>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move ||
        spawn_agent_process(persona, channels, owner, relays, repo, base_branch, manual.unwrap_or(false)))
        .await.map_err(|e| e.to_string())?
}

/// All callers share replacement and reuse under the same lifecycle lock.
pub(crate) fn spawn_agent_process(
    persona: String, channels: Vec<String>, owner: String, relays: String,
    repo: Option<String>, base_branch: Option<String>, manual: bool,
) -> Result<u32, String> {
    validate_agent_launch(&persona, repo.as_deref(), base_branch.as_deref())?;
    desktop_runtime::start(owner.clone(), relays.clone())?;
    managed_node::ensure_for_mcp_servers(&settings_value())?;
    let _guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    spawn_agent_locked(persona, channels, owner, relays, repo, base_branch, manual)
}

fn validate_agent_launch(persona: &str, repo: Option<&str>, branch: Option<&str>) -> Result<(), String> {
    if !valid_persona_name(persona) { return Err("invalid persona name".into()); }
    for (label, value) in [("repo", repo), ("branch", branch)] {
        if let Some(value) = value {
            if !safe_work(value) { return Err(format!("unsafe {label} name refused: {value}")); }
        }
    }
    Ok(())
}

fn spawn_agent_locked(
    persona: String, channels: Vec<String>, owner: String, relays: String,
    repo: Option<String>, base_branch: Option<String>, manual: bool,
) -> Result<u32, String> {
    validate_agent_launch(&persona, repo.as_deref(), base_branch.as_deref())?;
    desktop_runtime::check_running()?;
    let existing = load_agents_registry().into_iter()
        .find(|r| r.persona == persona && r.bin == "fez-agent" && desktop_runtime::row_alive(r))
        .or_else(|| sentinel_agent_pid(&persona).map(|pid| SpawnedAgent {
            persona: persona.clone(), channels: channels.clone(), repo: repo.clone(), line: base_branch.clone(), pid,
            bin: default_bin(), spawned_at: None, process_start: desktop_runtime::process_start(pid), owner: Some(owner.clone()), relays: Some(relays.clone()),
        }));
    if let Some(existing) = existing {
        let pid = existing.pid;
        if manual {
            desktop_runtime::stop_process(&existing)?;
        } else {
            // Adopt a verified bundled body left by the old sentinel.
            let mut rows = load_agents_registry();
            if let Some(row) = rows.iter_mut().find(|r| r.persona == persona && r.bin == "fez-agent" && r.pid == pid) {
                row.owner.get_or_insert(owner);
                row.relays.get_or_insert(relays);
                row.process_start = desktop_runtime::process_start(pid);
                save_agents_registry(&rows)?;
            } else {
                rows.retain(|r| r.persona != persona || r.bin != "fez-agent");
                rows.push(SpawnedAgent { persona, channels, repo, line: base_branch, pid,
                    bin: default_bin(), spawned_at: None, process_start: desktop_runtime::process_start(pid), owner: Some(owner), relays: Some(relays) });
                save_agents_registry(&rows)?;
            }
            return Ok(pid);
        }
    }
    let mut env = vec![
        ("FEZ_AGENT_PERSONA".to_string(), persona.clone()),
        ("FEZ_AGENT_CHANNELS".to_string(), channels.join(",")),
        ("FEZ_AGENT_OWNER".to_string(), owner),
        ("FEZ_RELAY".to_string(), relays),
    ];
    if manual { env.push(("FEZ_AGENT_TAKEOVER".into(), "1".into())); }
    if std::env::var_os("CODEX_PATH").is_none() {
        if let Some(path) = harness_path("codex") {
            env.push(("CODEX_PATH".into(), path.to_string_lossy().into_owned()));
        }
    }
    if let Some(r) = &repo {
        env.push(("FEZ_AGENT_REPO".to_string(), r.clone()));
        if let Some(b) = &base_branch { env.push(("FEZ_AGENT_BASE_BRANCH".to_string(), b.clone())); }
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
#[tauri::command]
async fn spawn_extension_agent(
    extension: String,
    bin: String,
    name: String,
    env: Vec<(String, String)>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = fez_home().ok().and_then(|home| package_install::installed_manifest(&extension, &home));
        extension_may_spawn(&settings_value(), manifest.as_ref(), &extension, &bin)?;
        let env = checked_env(env)?;
        desktop_runtime::start(get_pubkey(None)?, String::new())?;
        managed_node::ensure_for_program(&fez_home()?.join("bin").join(&bin))?;
        let _guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        desktop_runtime::check_running()?;
        if let Some(row) = load_agents_registry().into_iter()
            .find(|r| r.persona == name && r.bin == bin && desktop_runtime::row_alive(r)) {
            return Ok(row.pid);
        }
        spawn_tracked_process(name, &bin, env, vec![], None, None)
    })
    .await
    .map_err(|e| format!("extension startup task panicked: {e}"))?
}

/// One-shot: run a bin THIS extension's package ships and return what it
/// printed — the ceremony seam (fez-wallet init/derive from the wallet
/// panel, and whatever the next extension's owner-side act is). The
/// authority gate is spawn_extension_agent's exactly (extension_may_spawn:
/// the `processes` grant plus the manifest's own bin claim); the
/// difference is shape — this runs to completion and hands back stdout,
/// where spawn starts a standing process and hands back a pid. Args are
/// plain strings passed verbatim to the extension's OWN binary; a 120s
/// deadline covers the process and pipe capture. Combined output over 8 MiB
/// fails explicitly so consumers never parse silently truncated output.
#[tauri::command]
async fn run_extension_bin(
    extension: String,
    bin: String,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = fez_home()?;
        let manifest = package_install::installed_manifest(&extension, &home);
        extension_may_spawn(&settings_value(), manifest.as_ref(), &extension, &bin)?;
        let program = home.join("bin").join(&bin);
        managed_node::ensure_for_program(&program)?;
        let guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        desktop_runtime::check_running()?;
        let output = bounded_command::run_with_lifecycle(
            Command::new(&program).args(&args).env("PATH", subprocess_path_env()),
            std::time::Duration::from_secs(120),
            8 * 1024 * 1024,
            move |pid| { desktop_runtime::track_group(pid); drop(guard); },
            |pid| {
                let guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
                desktop_runtime::forget_group(pid);
                guard
            },
        ).map_err(|e| format!("{bin}: {e}"))?;
        let code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8(output.stdout).map_err(|_| format!("{bin}: stdout was not valid UTF-8"))?;
        let stderr = String::from_utf8(output.stderr).map_err(|_| format!("{bin}: stderr was not valid UTF-8"))?;
        Ok(serde_json::json!({ "code": code, "stdout": stdout, "stderr": stderr }))
    })
    .await
    .map_err(|e| format!("run task panicked: {e}"))?
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

use package_install::extension_may_spawn;

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

/// THE spawn primitive: validation, env, process group, reap thread, and the
/// pid registry, in one place. Every policy caller goes through here — nothing
/// reaches Command::spawn directly, which is the point.
///
/// A PATH that can actually run a `#!/usr/bin/env node` shebang: the GUI
/// process inherits launchd's PATH (/usr/bin:/bin:…), which has no node
/// on an nvm machine — the wallet ceremony's very first click died with
/// "env: node: No such file or directory", and every JS bin an extension
/// ships (fez-bazaar-miner.js included) hits the same wall. Prepend the
/// runtimes fez can vouch for: the managed node the Claude bridge
/// installs, then the standard homes.
fn subprocess_path_env() -> String {
    let mut path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    let candidates = [
        managed_node::node_bin_dir(),
        std::path::PathBuf::from("/opt/homebrew/bin"),
        std::path::PathBuf::from("/usr/local/bin"),
    ];
    // Reverse order so the FIRST candidate ends up first on PATH.
    for dir in candidates.iter().rev() {
        if dir.join("node").exists() {
            path = format!("{}:{}", dir.display(), path);
        }
    }
    path
}

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
    // Caller holds AGENTS_REGISTRY_LOCK through registry commit.
    desktop_runtime::check_running()?;
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
    cmd.env("PATH", subprocess_path_env());
    for (k, v) in &env {
        cmd.env(k, v);
    }
    use std::os::unix::process::CommandExt;
    cmd.env("FEZ_DESKTOP_PARENT_PID", std::process::id().to_string())
        .stdin(std::process::Stdio::null()).stdout(log).stderr(log_err).process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;
    let pid = child.id();
    desktop_runtime::track_group(pid);
    let exit_key = format!("{name}\x00{bin}");
    let exit_name = name.clone();
    let exit_bin = bin.to_string();
    {
        let mut m = LAST_EXITS.lock().unwrap_or_else(|p| p.into_inner());
        m.get_or_insert_with(Default::default).remove(&exit_key);
    }
    let log_path = log_dir.join(format!("{name}.log"));
    // Reap it: an unwaited Child that exits becomes a ZOMBIE, and `kill -0`
    // succeeds on a zombie — so a dead process kept reading as "alive" until
    // the whole app quit, suppressing the engine's 90s watchdog and making the
    // name unspawnable. This thread's only job is the wait() — plus writing
    // down WHY it ended, so a row can say "died: no Anthropic key" instead
    // of silently flipping its button back.
    std::thread::spawn(move || {
        // Observe without reaping: keep the leader PID reserved until group cleanup.
        while matches!(bounded_command::has_exited(pid), Ok(false)) {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let _guard = AGENTS_REGISTRY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        desktop_runtime::finish_group(pid);
        let status = child.wait();
        let expected = EXPECTED_STOPS.lock().unwrap_or_else(|p| p.into_inner())
            .get_or_insert_with(Default::default).remove(&pid);
        // A replaced body's exit must never overwrite the new body's state.
        if expected || !load_agents_registry().iter().any(|r|
            r.persona == exit_name && r.bin == exit_bin && r.pid == pid) { return; }
        let code = status.ok().and_then(|st| st.code());
        let tail = std::fs::read_to_string(&log_path)
            .ok()
            .and_then(|text| text.lines().rev().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string()))
            .unwrap_or_default();
        let reason = match code {
            Some(0) => format!("exited cleanly{}", if tail.is_empty() { String::new() } else { format!(" — {tail}") }),
            Some(c) => format!("exit {c}{}", if tail.is_empty() { String::new() } else { format!(" — {tail}") }),
            None if exit_bin == "fez-agent" && tail == format!("FEZ_AGENT_STOPPED={pid}") => "exited cleanly".into(),
            None => format!("killed{}", if tail.is_empty() { String::new() } else { format!(" — {tail}") }),
        };
        {
            let mut m = LAST_EXITS.lock().unwrap_or_else(|p| p.into_inner());
            m.get_or_insert_with(Default::default).insert(exit_key, reason.clone());
        }
        if let Some(handle) = APP_HANDLE.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            use tauri::Emitter;
            let _ = handle.emit("fez-agent-exit", serde_json::json!({
                "name": exit_name, "bin": exit_bin, "reason": reason,
            }));
        }
    });
    let mut rows: Vec<SpawnedAgent> = load_agents_registry().into_iter()
        .filter(|r| r.persona != name || r.bin != bin).collect();
    rows.push(SpawnedAgent {
        persona: name,
        channels,
        repo,
        line: base_branch,
        pid,
        bin: bin.to_string(),
        process_start: desktop_runtime::process_start(pid),
        owner: env.iter().find(|(k, _)| k == "FEZ_AGENT_OWNER").map(|(_, v)| v.clone()),
        relays: env.iter().find(|(k, _)| k == "FEZ_RELAY").map(|(_, v)| v.clone()),
        spawned_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs()),
    });
    if let Err(e) = save_agents_registry(&rows) {
        if let Some(row) = rows.iter().find(|r| r.pid == pid) { let _ = desktop_runtime::stop_process(row); }
        return Err(e);
    }
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
    let mut rows = load_agents_registry();
    let matching: Vec<_> = rows.iter().filter(|r| r.persona == persona && bin.as_deref().is_none_or(|b| r.bin == b)).cloned().collect();
    desktop_runtime::reject_unresolved_legacy(&matching)?;
    let mut killed = false;
    for row in rows.iter().filter(|r| r.persona == persona && bin.as_deref().is_none_or(|b| r.bin == b)) {
        killed |= desktop_runtime::stop_process(row)?;
    }
    // A pre-migration bundled agent can have only its sentinel pid receipt.
    if bin.as_deref().is_none_or(|b| b == "fez-agent") {
        if let Some(pid) = sentinel_agent_pid(&persona) {
            let row = SpawnedAgent { persona: persona.clone(), channels: vec![], repo: None, line: None, pid, bin: default_bin(),
                spawned_at: None, process_start: desktop_runtime::process_start(pid), owner: None, relays: None };
            killed |= desktop_runtime::stop_process(&row)?;
        }
    }
    rows.retain(|r| r.persona != persona || !bin.as_deref().is_none_or(|b| r.bin == b));
    save_agents_registry(&rows)?;
    Ok(killed)
}

#[tauri::command]
fn agent_last_exit(persona: String, bin: String) -> Option<String> {
    let key = format!("{persona}\x00{bin}");
    LAST_EXITS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .and_then(|m| m.get(&key).cloned())
}

#[tauri::command]
fn agent_alive(persona: String, bin: Option<String>) -> bool {
    agent_is_alive_bin(&persona, bin.as_deref())
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
        .any(|r| r.persona == persona && bin.is_none_or(|b| r.bin == b) && desktop_runtime::row_alive(r));
    registry_alive || (bin.is_none_or(|b| b == "fez-agent") && sentinel_agent_pid(persona).is_some())
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
        ("fez-background", false),
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
    //
    // Theme and wasm are OPTIONAL in the bundle (prepare-pi-agent.mjs
    // copies each only `if existsSync`), so their absence must be
    // optional here too: a required copy failed AFTER the binaries were
    // already renamed into place, the version marker never stamped, and
    // every launch re-copied 140MB while appearing to work.
    if src.join("theme").is_dir() {
        let theme_dst = bin.join("theme");
        let _ = std::fs::remove_dir_all(&theme_dst);
        std::fs::create_dir_all(&theme_dst).map_err(|e| format!("mkdir theme: {e}"))?;
        let entries = std::fs::read_dir(src.join("theme")).map_err(|e| format!("read theme: {e}"))?;
        for e in entries {
            let e = e.map_err(|e| format!("read theme: {e}"))?;
            std::fs::copy(e.path(), theme_dst.join(e.file_name()))
                .map_err(|err| format!("copy theme/{}: {err}", e.file_name().to_string_lossy()))?;
        }
    }
    if src.join("photon_rs_bg.wasm").is_file() {
        std::fs::copy(src.join("photon_rs_bg.wasm"), bin.join("photon_rs_bg.wasm"))
            .map_err(|e| format!("copy photon_rs_bg.wasm: {e}"))?;
    }
    Ok(())
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> { tauri::generate_context!() }

fn command_handler<F>(next: F) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static
where F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    let next = isolated_panel::guard(next);
    #[cfg(feature = "native-browser")]
    let next = native_surfaces::handler(next);
    next
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "native-browser")]
    let builder = native_surfaces::configure(builder, None).expect("configure native browser");
    let app = builder
        .channel_interceptor(isolated_panel::channel_message)
        .manage(isolated_panel::PanelHost::new(fez_home().expect("Fez home directory")))
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
        .on_page_load(|webview, payload| {
            use tauri::Manager;
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                webview.state::<isolated_panel::PanelHost>().close_all(webview.app_handle());
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "fez-show" { desktop_runtime::show(app); }
            if event.id().as_ref() == "fez-quit" { app.exit(0); }
            if event.id().as_ref() == "fez-check-updates" {
                use tauri::Emitter;
                // The webview owns the updater flow (plugin JS API + toasts);
                // the native menu just rings the bell.
                let _ = app.emit("fez-check-updates", ());
            }
        })
        .setup(|app| {
            #[cfg(not(feature = "native-browser"))]
            desktop_runtime::claim().map_err(std::io::Error::other)?;
            #[cfg(feature = "native-browser")]
            {
                let source = app.path().resource_dir()?.join("bundled-extensions");
                bundled_extensions::install_missing(&source, &fez_home().map_err(std::io::Error::other)?,
                    |name, bytes, version| finish_install(name, bytes, version).map(|_| ()))
                    .map_err(std::io::Error::other)?;
                native_surfaces::open_main(app)?;
            }
            #[cfg(all(target_os = "macos", feature = "cef-prototype"))]
            cef_prototype::start(app).map_err(std::io::Error::other)?;
            *APP_HANDLE.lock().unwrap_or_else(|p| p.into_inner()) = Some(app.handle().clone());
            // CEF forwards native Quit through ExitRequested itself. Only Tao
            // needs the supplemental delegate method for our confirmation.
            #[cfg(all(target_os = "macos", not(feature = "native-browser")))]
            desktop_runtime::macos_quit::install().map_err(std::io::Error::other)?;
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
            {
                use tauri::menu::{Menu, MenuItem};
                let show = MenuItem::with_id(app, "fez-show", "Show Fez", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "fez-quit", "Quit Fez…", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show])?;
                let mut tray = tauri::tray::TrayIconBuilder::new().tooltip("Fez");
                #[cfg(target_os = "macos")]
                {
                    use tauri::{menu::CheckMenuItem, Emitter};
                    let mut awake = always_on::AlwaysOn::new(fez_home().map_err(std::io::Error::other)?.join("desktop-always-on"));
                    let restored = awake.restore();
                    if let Err(error) = &restored { eprintln!("{error}"); }
                    let toggle = CheckMenuItem::with_id(app, "fez-always-on",
                        if restored.is_ok() { "Always On" } else { "Always On (unavailable)" },
                        true, awake.enabled(), None::<&str>)?;
                    menu.append(&toggle)?;
                    let awake = Mutex::new(awake);
                    tray = tray.on_menu_event(move |app, event| {
                        if event.id() != toggle.id() { return; }
                        let mut awake = awake.lock().unwrap_or_else(|p| p.into_inner());
                        let enabled = !awake.enabled();
                        let result = awake.set_enabled(enabled);
                        // Native check items toggle before dispatch; a failure must undo the check.
                        let _ = toggle.set_checked(awake.enabled());
                        let _ = toggle.set_text(if result.is_ok() { "Always On" } else { "Always On (unavailable)" });
                        if let Err(error) = result {
                            eprintln!("{error}");
                            desktop_runtime::show(app);
                            let _ = app.emit("always-on-error", error);
                        }
                    });
                }
                menu.append(&quit)?;
                tray = tray.menu(&menu);
                #[cfg(target_os = "macos")]
                {
                    tray = tray.icon(tauri::include_image!("icons/tray-icon.png"))
                        .icon_as_template(true);
                }
                #[cfg(not(target_os = "macos"))]
                if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
                tray.build(app)?;
            }
            // Off the main thread: the copy moves ~140MB on a version bump,
            // and running it synchronously here held the window back —
            // first launch looked hung with no window and no progress.
            use tauri::Manager;
            if let Ok(dir) = app.path().resource_dir() {
                let handle = app.handle().clone();
                std::thread::spawn(move || install_bundled_agent(handle, dir.join("pi-agent")));
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
        .invoke_handler(command_handler(tauri::generate_handler![notifications::notify_with_click, isolated_panel::open_isolated_panel, isolated_panel::update_isolated_panel, isolated_panel::close_isolated_panel, isolated_panel::isolated_panel_request, isolated_panel::isolated_panel_reply, isolated_panel::isolated_panel_host_request, isolated_panel::isolated_panel_validate_request, stage_artifact, release_artifact, get_pubkey, ensure_agent_identity, sign_event, nip44_encrypt, nip44_decrypt, dm_wrap_all, dm_unwrap, get_identity, set_identity, write_persona, list_personas, read_persona, persona_mtime, update_persona, rename_persona, delete_persona, list_gui_extensions, extension_storage_read, extension_storage_write, list_local_extensions, list_installed_skills, read_extension_grants, list_persona_drafts, read_persona_draft, approve_persona_draft, reject_persona_draft, write_persona_draft, read_skills, write_skill, remove_skill, set_skill_secret, has_skill_secret, delete_skill_secret, read_bench_proposals, decide_bench_proposal, read_keymap, write_keymap, install_package, remove_extension, read_extension_versions, latest_version, package_info, export_tool, wire_chutes_pi, wire_provider_pi, provider_key_present, detect_harnesses, claude_brain_status, ensure_claude_adapter, codex_brain_status, ensure_codex_adapter, factory_reset, ensure_local_relay, local_relay_status, write_relays, workspace_owner_pin, write_media_server, read_media_server, runner_status, connect_service, desktop_runtime::start_desktop_runtime, desktop_runtime::confirm_desktop_quit, spawn_agent, kill_agent, agent_alive, agent_last_exit, spawned_agents, managed_agents::start_managed_agent, spawn_extension_agent, run_extension_bin, inspect_git_package, install_git_package]))
        .build(app_context())
        .expect("error while building tauri application");
    #[cfg(all(target_os = "macos", feature = "cef-prototype"))]
    cef_prototype::initialize_engine(None).expect("initialize native browser before the event loop");
    app.run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => desktop_runtime::quit_requested(app, &api),
            tauri::RunEvent::Exit => {
                #[cfg(all(target_os = "macos", feature = "cef-prototype"))]
                cef_prototype::stop();
                desktop_runtime::shutdown();
            },
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => desktop_runtime::show(app),
            _ => {},
        });
}

/// The fez host version `fez.minFezVersion` is enforced against — a
/// mirror of FEZ_VERSION in src/extensions/host-compat.ts. The
/// host-compat eval in fez-evals keeps the two equal; bump them together.
const FEZ_VERSION: &str = "0.2.3";

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
mod identity_key_tests {
    #[test]
    fn keychain_presence_distinguishes_missing_from_access_failure() {
        assert_eq!(super::keychain_presence(Some(0)), Ok(true));
        assert_eq!(super::keychain_presence(Some(44)), Ok(false));
        assert!(super::keychain_presence(Some(36)).is_err());
        assert!(super::keychain_presence(None).is_err());
    }

    use super::ensure_identity_key;

    #[test]
    fn existing_identity_is_reused_without_writing() {
        let key = nostr::Keys::generate();
        let actual = ensure_identity_key(Ok(Some(key.secret_key().to_secret_hex())), |_| {
            panic!("existing identities must not be overwritten")
        }).unwrap();
        assert_eq!(actual.public_key(), key.public_key());
    }

    #[test]
    fn absent_identity_is_saved_before_its_pubkey_is_returned() {
        let mut saved = None;
        let key = ensure_identity_key(Ok(None), |hex| {
            saved = Some(hex.to_string());
            Ok(())
        }).unwrap();
        assert_eq!(nostr::Keys::parse(&saved.unwrap()).unwrap().public_key(), key.public_key());
    }

    #[test]
    fn denied_or_malformed_identity_never_mints_a_replacement() {
        for read in [Err("keychain access denied".to_string()), Ok(Some("invalid".to_string()))] {
            assert!(ensure_identity_key(read, |_| panic!("read failure must not write")).is_err());
        }
    }

    #[test]
    fn failed_save_does_not_report_an_identity() {
        assert_eq!(ensure_identity_key(Ok(None), |_| Err("keychain write failed".to_string())).unwrap_err(), "keychain write failed");
    }
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
mod auth_probe_tests {
    use super::probe_claude_auth;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn auth_probe_drains_noisy_stderr_before_exit() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(&program, "#!/bin/sh\nhead -c 262144 /dev/zero >&2\nprintf '{\"loggedIn\":true}'\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(probe_claude_auth(&program));
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
    fn table_has_every_provider() {
        for p in ["chutes", "anthropic", "openai", "openrouter", "gm"] {
            assert!(provider_spec(p).is_some(), "missing provider {p}");
        }
        assert!(provider_spec("nope").is_none());
    }
    #[test]
    fn chutes_id_matches_the_legacy_constant() {
        // sha256("https://llm.chutes.ai/v1")[..10] — pinned by the existing wiring.
        assert_eq!(local_provider_id("https://llm.chutes.ai/v1"), "56105ece7a");
        // GM's, pinned the same way — ModelPicker keys its optgroup off this.
        assert_eq!(local_provider_id("https://api.saygm.com/v1"), "ebfd09756a");
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

#[cfg(test)]
mod remove_extension_settings_tests {
    use super::{extension_name_candidates, forget_extension_settings};

    #[test]
    fn candidates_cover_the_prefixed_and_bare_names() {
        assert_eq!(extension_name_candidates("browser"), vec!["browser", "fez-browser"]);
        assert_eq!(extension_name_candidates("fez-browser"), vec!["fez-browser", "browser"]);
    }

    /// The gallery strips `fez-` before calling remove, but a linked package's
    /// skill is recorded under its full name — found live: `fez-browser` stayed
    /// in mcpServers after "browser" was uninstalled, pointing at a dist that
    /// was gone.
    #[test]
    fn uninstall_by_bare_name_forgets_the_prefixed_skill_entry() {
        let mut settings = serde_json::json!({
            "extensionPermissions": { "browser": ["ui"] },
            "backgroundExtensions": ["fez-browser"],
            "mcpServers": { "fez-browser": { "command": "node" }, "browser-use": { "command": "node" } },
            "extensionBins": { "fez-browser": ["fez-browser"] }
        });
        let bins = forget_extension_settings(&mut settings, "browser");
        assert_eq!(bins, vec!["fez-browser"]);
        assert!(settings["extensionPermissions"].get("browser").is_none());
        assert_eq!(settings["backgroundExtensions"], serde_json::json!([]));
        assert!(settings["mcpServers"].get("fez-browser").is_none(), "prefixed skill entry must go");
        assert!(settings["mcpServers"].get("browser-use").is_some(), "a different package stays");
    }
}
