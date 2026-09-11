use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::{oneshot, Semaphore};
use std::sync::Arc;
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Mutex, atomic::{AtomicU64, Ordering}}};
use tauri::{Manager, Runtime};

/// Tauri 2's large-channel fetch queue is app-wide and exempt from plugin ACL.
/// Deliver to the channel's actual webview directly, so nothing enters that queue.
pub(crate) fn channel_message<R: Runtime>(webview: &tauri::Webview<R>, callback: tauri::ipc::CallbackFn, index: usize, body: &tauri::ipc::InvokeResponseBody) -> bool {
    let message = match body {
        tauri::ipc::InvokeResponseBody::Json(json) => format!("JSON.parse({})", serde_json::to_string(json).unwrap()),
        tauri::ipc::InvokeResponseBody::Raw(bytes) => format!("new Uint8Array({}).buffer", serde_json::to_string(bytes).unwrap()),
    };
    let _ = webview.eval(format!("window.__TAURI_INTERNALS__.runCallback({},{{index:{index},message:{message}}})", callback.0));
    // An eval failure must not fall back to the unscoped queue.
    true
}

/// All app commands, including future ones, require the main webview.
/// Plugin commands have their separate Tauri ACL, also scoped to that webview.
pub(crate) fn guard<R: Runtime, F>(next: F) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
where F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke.message.webview_ref().label() != "main" && invoke.message.command() != "isolated_panel_request" {
            invoke.resolver.reject("native command denied for this webview");
            return true;
        }
        next(invoke)
    }
}

struct Session {
    name: String,
    code: String,
    styles: String,
    agents: Vec<(String, String)>,
    host_requests: Option<tauri::ipc::Channel<u64>>,
    active: Arc<Semaphore>,
}

pub(crate) struct PanelHost {
    home: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
}

impl PanelHost {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self { home, sessions: Mutex::new(HashMap::new()), next: AtomicU64::new(1), pending: Mutex::new(HashMap::new()) }
    }

    fn grants(&self, name: &str) -> Result<Vec<String>, String> {
        let manifest = super::package_install::installed_manifest(name, &self.home)
            .ok_or("extension is no longer installed")?;
        if manifest.pointer("/fez/parts/gui").and_then(Value::as_str).is_none() {
            return Err("extension has no GUI part".into());
        }
        let settings: Value = serde_json::from_str(&std::fs::read_to_string(self.home.join("settings.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let grants: Vec<String> = serde_json::from_value(settings["extensionPermissions"][name].clone())
            .map_err(|_| "extension has no recorded grants")?;
        if !grants.iter().any(|g| g == "ui") { return Err("extension requires ui permission".into()); }
        Ok(grants)
    }

    fn bind(&self, name: &str, agents: Vec<(String, String)>) -> Result<String, String> {
        // The installed manifest validates the namespace; identity never comes
        // from a broker request supplied by extension code.
        self.grants(name)?;
        if agents.len() > 1000 || agents.iter().any(|(pk, name)| pk.len() != 64 || !pk.bytes().all(|c| c.is_ascii_hexdigit()) || name.len() > 256) {
            return Err("invalid agent snapshot".into());
        }
        let (_, code, styles, _) = super::package_install::gui_parts(&self.home).into_iter()
            .find(|(part, _, _, _)| part == name).ok_or("installed GUI bundle unavailable")?;
        if code.len() + styles.len() > 8 * 1024 * 1024 { return Err("GUI bundle exceeds pilot limit".into()); }
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= 8 { return Err("close an existing extension panel first".into()); }
        let label = format!("extension-panel-{}", self.next.fetch_add(1, Ordering::Relaxed));
        sessions.insert(label.clone(), Session { name: name.into(), code, styles, agents, host_requests: None, active: Arc::new(Semaphore::new(16)) });
        Ok(label)
    }

    fn remove(&self, label: &str) {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner()).remove(label);
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).retain(|_, pending| pending.label != label);
    }
}

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    ListChannels {},
    CreateChannel { name: String },
    Bootstrap,
    GetPreference { key: String },
    SetPreference { key: String, value: Value },
    GetConfig { extension: String },
    SetConfig { extension: String, value: Value },
    HasSecret { key: String },
    SetSecret { key: String, value: String },
    OpenUrl { url: String },
    HttpRequest { url: String, method: String, headers: Vec<(String, String)>, body: Option<String> },
}

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum HostOperation {
    ListChannels,
    CreateChannel { name: String },
    GetConfig { scope: String },
    SetConfig { scope: String, value: Value },
    HasSecret { scope: String, key: String },
    SetSecret { scope: String, key: String, value: String },
    OpenUrl { url: String },
}

struct Pending { label: String, request: Request, operation: Option<HostOperation>, reply: oneshot::Sender<Result<Value, String>> }

impl PanelHost {
    fn scope(&self, name: &str) -> Result<String, String> {
        // npm installs use `github`; local links also use `fez-github`.
        // They may share a legacy namespace only when it has ONE installed owner.
        let scope = if name.starts_with("fez-") { name.to_owned() } else { format!("fez-{name}") };
        let alias = if let Some(base) = name.strip_prefix("fez-") {
            if base.starts_with("fez-") { None } else { Some(base) }
        } else { Some(scope.as_str()) };
        if alias.is_some_and(|alias| super::package_install::installed_manifest(alias, &self.home).is_some()) {
            return Err("config and secrets have two installed namespace owners; remove the duplicate extension".into());
        }
        Ok(scope)
    }

    fn authorize(&self, label: &str, request: &Request) -> Result<String, String> {
        let name = self.sessions.lock().map_err(|e| e.to_string())?.get(label)
            .ok_or("unregistered isolated webview")?.name.clone();
        let grants = self.grants(&name)?;
        let require = |permission: &str| -> Result<(), String> {
            if grants.iter().any(|g| g == permission) { Ok(()) }
            else { Err(format!("extension requires {permission} permission")) }
        };
        match request {
            Request::ListChannels {} => require("read:channels")?,
            Request::CreateChannel { name } => {
                require("read:channels")?;
                require("publish")?;
                if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
                    return Err("channel name must be 1–256 bytes without control characters".into());
                }
            }
            Request::GetConfig { extension } | Request::SetConfig { extension, .. } => {
                // Never accept a caller-chosen namespace.
                if extension != &self.scope(&name)? { return Err("config belongs to another extension".into()); }
                require("read:channels")?;
                require("sign")?;
                if let Request::SetConfig { value, .. } = request {
                    require("publish")?;
                    if value.to_string().len() > 64 * 1024 { return Err("config exceeds 64 KiB".into()); }
                }
            }
            Request::HasSecret { key } | Request::SetSecret { key, .. } => {
                if self.scope(&name)?.len() > 64 { return Err("secret namespace exceeds 64 bytes".into()); }
                if key.is_empty() || key.len() > 64 || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
                    return Err("invalid secret key".into());
                }
                if let Request::SetSecret { value, .. } = request {
                    if value.is_empty() || value.len() > 64 * 1024 { return Err("secret must be 1–65536 bytes".into()); }
                }
            }
            Request::OpenUrl { url } | Request::HttpRequest { url, .. } => { allowed_url(url, &grants)?; }
            _ => {}
        }
        Ok(name)
    }

    async fn forward(&self, label: &str, request: &Request, operation: HostOperation) -> Result<Value, String> {
        let channel = self.sessions.lock().map_err(|e| e.to_string())?.get(label)
            .ok_or("isolated panel closed")?.host_requests.clone().ok_or("panel host unavailable")?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, receiver) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, Pending { label: label.into(), request: request.clone(), operation: Some(operation), reply });
        if let Err(error) = self.authorize(label, request) {
            self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
            return Err(error);
        }
        let sent = channel.send(id);
        let result = match sent {
            Ok(()) => match tokio::time::timeout(Duration::from_secs(30), receiver).await {
                Ok(Ok(value)) => value,
                Ok(Err(_)) => Err("isolated panel closed".into()),
                Err(_) => Err("panel host request timed out".into()),
            },
            Err(_) => Err("panel host unavailable".into()),
        };
        self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        result
    }
}

// Channels carry IDs only. Tauri 2's large channel payload queue is not
// webview-scoped; config and secrets must travel through main-only commands.
#[tauri::command]
pub(crate) fn isolated_panel_host_request(host: tauri::State<'_, PanelHost>, id: u64) -> Result<HostOperation, String> {
    let mut pending = host.pending.lock().map_err(|e| e.to_string())?;
    let pending = pending.get_mut(&id).ok_or("unknown or expired panel request")?;
    host.authorize(&pending.label, &pending.request)?;
    pending.operation.take().ok_or("panel request already taken".into())
}

#[tauri::command]
pub(crate) fn isolated_panel_reply(host: tauri::State<'_, PanelHost>, id: u64, result: Result<Value, String>) -> Result<(), String> {
    let pending = host.pending.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("unknown or expired panel request")?;
    pending.reply.send(result).map_err(|_| "isolated panel closed".into())
}

#[tauri::command]
pub(crate) async fn isolated_panel_request<R: Runtime>(webview: tauri::Webview<R>, host: tauri::State<'_, PanelHost>, request: Request) -> Result<Value, String> {
    let label = webview.label();
    let name = host.authorize(label, &request)?;
    let active = host.sessions.lock().map_err(|e| e.to_string())?.get(label).ok_or("isolated panel closed")?.active.clone();
    let permit = active.try_acquire_owned().map_err(|_| "too many pending panel requests")?;
    let scope = match &request {
        Request::GetConfig { .. } | Request::SetConfig { .. } | Request::HasSecret { .. } | Request::SetSecret { .. } => host.scope(&name)?,
        _ => String::new(),
    };
    let result = match &request {
        Request::ListChannels {} => host.forward(label, &request, HostOperation::ListChannels).await,
        Request::CreateChannel { name } => host.forward(label, &request, HostOperation::CreateChannel { name: name.clone() }).await,
        Request::Bootstrap => {
            let sessions = host.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions.get(label).ok_or("isolated panel closed")?;
            let grants = host.grants(&name)?;
            Ok(json!({
                "name": name, "code": session.code, "styles": session.styles,
                "client": grants.iter().any(|g| g == "read:channels"),
                "agents": if grants.iter().any(|g| g == "read:channels") && grants.iter().any(|g| g == "read:agents") { Some(&session.agents) } else { None },
            }))
        }
        Request::GetPreference { key } => {
            validate_key(key)?;
            let state = read_storage(&host.home, &name)?;
            Ok(match state.get("prefs").and_then(|prefs| prefs.get(key)) {
                Some(value) => json!({"value": value}), None => json!({}),
            })
        }
        Request::SetPreference { key, value } => {
            validate_key(key)?;
            if value.to_string().len() > 64 * 1024 { return Err("preference exceeds 64 KiB".into()); }
            write_preference(&host.home, &name, key, value.clone())?;
            Ok(Value::Null)
        }
        Request::GetConfig { .. } => host.forward(label, &request, HostOperation::GetConfig { scope }).await,
        Request::SetConfig { value, .. } => host.forward(label, &request, HostOperation::SetConfig { scope, value: value.clone() }).await,
        Request::HasSecret { key } => host.forward(label, &request, HostOperation::HasSecret { scope, key: key.clone() }).await,
        Request::SetSecret { key, value } => host.forward(label, &request, HostOperation::SetSecret { scope, key: key.clone(), value: value.clone() }).await,
        Request::OpenUrl { url } => host.forward(label, &request, HostOperation::OpenUrl { url: url.clone() }).await,
        Request::HttpRequest { url, method, headers, body } => {
            let (url, method, headers, body) = (url.clone(), method.clone(), headers.clone(), body.clone());
            tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                http_request(&url, &method, &headers, body.as_deref())
            }).await.map_err(|_| "HTTP request failed")?
        }
    };
    // Do not return data after a grant was revoked or the window closed.
    host.authorize(label, &request)?;
    result
}

fn allowed_url(url: &str, grants: &[String]) -> Result<tauri::Url, String> {
    if url.len() > 8192 { return Err("URL exceeds 8 KiB".into()); }
    let parsed = tauri::Url::parse(url).map_err(|_| "invalid URL")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port_or_known_default() != Some(443) {
        return Err("only HTTPS URLs on port 443 without credentials are allowed".into());
    }
    let host = parsed.host_str().ok_or("URL has no hostname")?;
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') || !host.contains('.') || host.ends_with('.') {
        return Err("a public hostname is required".into());
    }
    if !grants.iter().any(|grant| grant == &format!("network:{host}")) {
        return Err(format!("extension requires network:{host} permission"));
    }
    Ok(parsed)
}

fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_documentation()
                && a != 0 && a < 224 && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && c == 0) && !(a == 198 && (b == 18 || b == 19))
        }
        std::net::IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8)) && s[0] != 0x2002
        }
    }
}

fn http_request(url: &str, method: &str, headers: &[(String, String)], body: Option<&str>) -> Result<Value, String> {
    use std::net::ToSocketAddrs;
    if !matches!(method, "GET" | "HEAD" | "POST") { return Err("HTTP method must be GET, HEAD or POST".into()); }
    if body.is_some_and(|b| b.len() > 64 * 1024) { return Err("HTTP body exceeds 64 KiB".into()); }
    if headers.len() > 32 || headers.iter().map(|(k,v)| k.len()+v.len()).sum::<usize>() > 16 * 1024 {
        return Err("HTTP headers exceed limit".into());
    }
    for (key, value) in headers {
        let key = key.to_ascii_lowercase();
        if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') || value.bytes().any(|c| c < 32 || c == 127)
            || key.starts_with("proxy-") || key.starts_with("sec-")
            || matches!(key.as_str(), "host" | "cookie" | "cookie2" | "origin" | "referer" | "connection" | "content-length" | "transfer-encoding" | "te" | "upgrade") {
            return Err("HTTP header not permitted".into());
        }
    }
    let agent = ureq::AgentBuilder::new().redirects(0).https_only(true).try_proxy_from_env(false).timeout(Duration::from_secs(20))
        // Validate the addresses actually used for the connection, not a separate DNS lookup.
        .resolver(|host: &str| -> std::io::Result<Vec<std::net::SocketAddr>> {
            let addresses: Vec<_> = host.to_socket_addrs()?.collect();
            if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "non-public address denied"));
            }
            Ok(addresses)
        }).build();
    let mut req = agent.request(method, url);
    for (key, value) in headers { req = req.set(key, value); }
    let response = match body { Some(body) => req.send_string(body), None => req.call() };
    let response = match response {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(_) => return Err("HTTP request failed (connection, TLS, timeout or non-public address)".into()),
    };
    http_response(url, response)
}

fn http_response(url: &str, response: ureq::Response) -> Result<Value, String> {
    use std::io::Read;
    if (300..400).contains(&response.status()) { return Err("HTTP redirects are not permitted".into()); }
    let status = response.status();
    let headers: Vec<_> = response.headers_names().iter().filter(|name| name.as_str() != "set-cookie")
        .filter_map(|name| response.header(name).map(|value| (name.clone(), value.to_string()))).collect();
    let mut bytes = Vec::new();
    response.into_reader().take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "HTTP response could not be read")?;
    if bytes.len() > 2 * 1024 * 1024 { return Err("HTTP response exceeds 2 MiB".into()); }
    let body = String::from_utf8(bytes).map_err(|_| "HTTP response is not UTF-8 text")?;
    Ok(json!({ "url": url, "status": status, "headers": headers, "body": body }))
}

#[tauri::command]
pub(crate) fn open_isolated_panel<R: Runtime>(webview: tauri::Webview<R>, app: tauri::AppHandle<R>, host: tauri::State<'_, PanelHost>, name: String, agents: Vec<(String, String)>, host_requests: Option<tauri::ipc::JavaScriptChannelId>) -> Result<(), String> {
    if !cfg!(target_os = "macos") { return Err("isolated settings currently require macOS".into()); }
    let mut entry: tauri::Url = if tauri::is_dev() {
        app.config().build.dev_url.clone().ok_or("missing development URL")?
    } else if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost".parse().unwrap()
    } else { "tauri://localhost".parse().unwrap() };
    entry.set_path("/isolated-panel.html");
    entry.set_query(None);
    entry.set_fragment(None);
    let label = host.bind(&name, agents)?;
    host.sessions.lock().map_err(|e| e.to_string())?.get_mut(&label).ok_or("isolated panel closed")?.host_requests = host_requests.map(|id| id.channel_on(webview));
    let result = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("isolated-panel.html".into()))
        .title(format!("{name} · settings")).inner_size(640.0, 480.0)
        .incognito(true).disable_drag_drop_handler()
        .on_navigation(move |url| url == &entry)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    match result {
        Ok(window) => {
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) { app.state::<PanelHost>().remove(&label); }
            });
            Ok(())
        }
        Err(error) => { host.remove(&label); Err(error.to_string()) }
    }
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) {
        return Err("invalid preference key".into());
    }
    Ok(())
}

fn storage_path(home: &Path, name: &str) -> Result<PathBuf, String> {
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) || name.contains("..") || name.len() > 128
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) {
        return Err("invalid extension name".into());
    }
    Ok(home.join("extension-data").join(format!("{name}.json")))
}

pub(crate) fn read_storage(home: &Path, name: &str) -> Result<Value, String> {
    let raw = match std::fs::read_to_string(storage_path(home, name)?) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(error.to_string()),
    };
    let state: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid extension state: {e}"))?;
    if !state.is_object() || state.get("prefs").is_some_and(|prefs| !prefs.is_object()) {
        return Err("extension state and prefs must be objects".into());
    }
    Ok(state)
}

// ponytail: serializes native writers only. CLI writers need a shared file lock
// if concurrent GUI/CLI updates to the same extension state become necessary.
static STORAGE_LOCK: Mutex<()> = Mutex::new(());
static WRITE_NEXT: AtomicU64 = AtomicU64::new(1);

pub(crate) fn write_preference(home: &Path, name: &str, key: &str, value: Value) -> Result<(), String> {
    use std::io::Write;
    let _lock = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    let file = storage_path(home, name)?;
    let mut state = read_storage(home, name)?;
    if state.get("prefs").is_none() { state["prefs"] = json!({}); }
    state["prefs"][key] = value;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = file.with_extension(format!("{}.{}.tmp", std::process::id(), WRITE_NEXT.fetch_add(1, Ordering::Relaxed)));
    let result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut writer = options.open(&temp).map_err(|e| e.to_string())?;
        writer.write_all(serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        writer.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &file).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temp); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::{test::{mock_builder, get_ipc_response, INVOKE_KEY}, Manager};

    fn ipc(view: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
        get_ipc_response(view, tauri::webview::InvokeRequest {
            cmd: cmd.into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(), body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(), invoke_key: INVOKE_KEY.into(),
        }).map(|response| response.deserialize().unwrap())
    }

    fn fixture() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let package = home.path().join("packages/elevenlabs");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), r#"{"fez":{"parts":{"gui":"gui.js"}}}"#).unwrap();
        std::fs::write(package.join("gui.js"), "var __fezExt={default(){}};").unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels","read:agents"]}}"#).unwrap();
        home
    }

    #[test]
    fn native_commands_and_plugins_are_bound_to_the_actual_webview() {
        let app = mock_builder().invoke_handler(guard(|invoke| {
            invoke.resolver.resolve("reached native handler"); true
        })).build(super::super::app_context()).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let panel = tauri::WebviewWindowBuilder::new(&app, "extension-panel-1", Default::default()).build().unwrap();
        for command in ["get_identity", "sign_event", "install_package", "extension_storage_write", "future_native_command"] {
            assert_eq!(ipc(&main, command, json!({})), Ok(json!("reached native handler")));
            let error = ipc(&panel, command, json!({"label":"main"})).unwrap_err();
            assert!(error.to_string().contains("denied"), "{error}");
        }
        assert!(ipc(&main, "plugin:event|emit", json!({"event":"probe","payload":null})).is_ok());
        assert!(ipc(&panel, "plugin:event|emit", json!({"event":"probe","payload":null})).is_err());
    }

    #[test]
    fn different_extensions_have_independent_namespaces_and_grants() {
        let home = fixture();
        let other = home.path().join("packages/notes");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("package.json"), r#"{"fez":{"parts":{"gui":"gui.js"}}}"#).unwrap();
        std::fs::write(other.join("gui.js"), "var __fezExt={default(){}};").unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui"],"notes":["ui"]}}"#).unwrap();
        let host = PanelHost::new(home.path().to_owned());
        let first = host.bind("elevenlabs", vec![]).unwrap();
        let second = host.bind("notes", vec![]).unwrap();
        assert_ne!(first, second);
        assert!(host.bind("../notes", vec![]).is_err());
        let app = mock_builder().manage(host).invoke_handler(guard(tauri::generate_handler![isolated_panel_request]))
            .build(super::super::app_context()).unwrap();
        let first = tauri::WebviewWindowBuilder::new(&app, first, Default::default()).build().unwrap();
        let second = tauri::WebviewWindowBuilder::new(&app, second, Default::default()).build().unwrap();
        let request = |view: &tauri::WebviewWindow<tauri::test::MockRuntime>, value| ipc(view, "isolated_panel_request", json!({"request":value}));
        for (view, name) in [(&first, "elevenlabs"), (&second, "notes")] {
            assert_eq!(request(view, json!({"op":"bootstrap"})).unwrap()["name"], name);
            request(view, json!({"op":"set_preference","key":"choice","value":name})).unwrap();
        }
        assert_eq!(request(&first, json!({"op":"get_preference","key":"choice"})).unwrap(), json!({"value":"elevenlabs"}));
        assert_eq!(request(&second, json!({"op":"get_preference","key":"choice"})).unwrap(), json!({"value":"notes"}));
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"notes":["ui"]}}"#).unwrap();
        assert!(request(&first, json!({"op":"set_preference","key":"choice","value":"overwrite"})).is_err());
        assert_eq!(request(&second, json!({"op":"get_preference","key":"choice"})).unwrap(), json!({"value":"notes"}));
        std::fs::remove_file(other.join("package.json")).unwrap();
        assert!(request(&second, json!({"op":"bootstrap"})).is_err());
    }

    #[test]
    fn broker_scopes_writes_rechecks_grants_and_preserves_state() {
        let home = fixture();
        let host = PanelHost::new(home.path().to_owned());
        let label = host.bind("elevenlabs", vec![("a".repeat(64), "fez".into())]).unwrap();
        let app = mock_builder().manage(host).invoke_handler(guard(tauri::generate_handler![isolated_panel_request]))
            .build(super::super::app_context()).unwrap();
        let panel = tauri::WebviewWindowBuilder::new(&app, &label, Default::default()).build().unwrap();
        let unknown = tauri::WebviewWindowBuilder::new(&app, "unregistered", Default::default()).build().unwrap();
        let request = |view: &tauri::WebviewWindow<tauri::test::MockRuntime>, value| ipc(view, "isolated_panel_request", json!({"request":value}));
        let bootstrap = request(&panel, json!({"op":"bootstrap"})).unwrap();
        assert_eq!(bootstrap["name"], "elevenlabs");
        assert_eq!(bootstrap["agents"][0][1], "fez");
        assert!(request(&unknown, json!({"op":"bootstrap"})).is_err());
        assert!(request(&panel, json!({"op":"get_identity"})).is_err());
        assert!(request(&panel, json!({"op":"set_preference","key":"voices","value":{},"name":"wallet"})).is_err());
        let file = home.path().join("extension-data/elevenlabs.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"ledger":[1],"prefs":{"old":true}}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        request(&panel, json!({"op":"set_preference","key":"voices","value":{"fez":"roger"}})).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let state: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(state, json!({"ledger":[1],"prefs":{"old":true,"voices":{"fez":"roger"}}}));
        assert_eq!(request(&panel, json!({"op":"get_preference","key":"voices"})).unwrap(), json!({"value":{"fez":"roger"}}));
        std::fs::write(&file, "broken json").unwrap();
        assert!(request(&panel, json!({"op":"set_preference","key":"voices","value":{}})).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "broken json");
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui"]}}"#).unwrap();
        assert!(request(&panel, json!({"op":"bootstrap"})).unwrap()["agents"].is_null());
        std::fs::write(home.path().join("settings.json"), "{}").unwrap();
        assert!(request(&panel, json!({"op":"set_preference","key":"voices","value":{}})).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "broken json");
        app.state::<PanelHost>().remove(&label);
        assert!(request(&panel, json!({"op":"bootstrap"})).is_err());
    }
    #[test]
    fn host_requests_are_scoped_single_use_and_require_main() {
        let home = fixture();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels","sign","publish","network:github.com"]}}"#).unwrap();
        let host = PanelHost::new(home.path().to_owned());
        let label = host.bind("elevenlabs", vec![]).unwrap();
        let (send, receive) = std::sync::mpsc::channel::<u64>();
        host.sessions.lock().unwrap().get_mut(&label).unwrap().host_requests = Some(tauri::ipc::Channel::new(move |body| {
            send.send(body.deserialize().unwrap()).unwrap(); Ok(())
        }));
        let app = mock_builder().manage(host).invoke_handler(guard(tauri::generate_handler![isolated_panel_request, isolated_panel_reply, isolated_panel_host_request]))
            .build(super::super::app_context()).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let panel = tauri::WebviewWindowBuilder::new(&app, &label, Default::default()).build().unwrap();
        for (request, expected, answer) in [
            (json!({"op":"list_channels"}), json!({"op":"list_channels"}), json!([{"id":"one","name":"work"}])),
            (json!({"op":"create_channel","name":"work"}), json!({"op":"create_channel","name":"work"}), json!("new-id")),
            (json!({"op":"get_config","extension":"fez-elevenlabs"}), json!({"op":"get_config","scope":"fez-elevenlabs"}), json!({"value":{"repos":["one/two"]}})),
            (json!({"op":"set_config","extension":"fez-elevenlabs","value":{"repos":["one/two"]}}), json!({"op":"set_config","scope":"fez-elevenlabs","value":{"repos":["one/two"]}}), Value::Null),
            (json!({"op":"set_secret","key":"token","value":"test-only"}), json!({"op":"set_secret","scope":"fez-elevenlabs","key":"token","value":"test-only"}), Value::Null),
            (json!({"op":"has_secret","key":"token"}), json!({"op":"has_secret","scope":"fez-elevenlabs","key":"token"}), json!(true)),
            (json!({"op":"open_url","url":"https://github.com/login/device"}), json!({"op":"open_url","url":"https://github.com/login/device"}), Value::Null),
        ] {
            let view = panel.clone();
            let pending = std::thread::spawn(move || ipc(&view, "isolated_panel_request", json!({"request":request})));
            let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
            assert!(ipc(&panel, "isolated_panel_host_request", json!({"id":id})).is_err());
            assert!(ipc(&panel, "isolated_panel_reply", json!({"id":id,"result":{"Ok":"forged"}})).is_err());
            assert_eq!(ipc(&main, "isolated_panel_host_request", json!({"id":id})), Ok(expected));
            assert!(ipc(&main, "isolated_panel_host_request", json!({"id":id})).is_err());
            ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Ok":answer}})).unwrap();
            assert_eq!(pending.join().unwrap(), Ok(answer));
            assert!(ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Ok":null}})).is_err());
        }
        for request in [
            json!({"op":"create_channel","name":" "}),
            json!({"op":"create_channel","name":"x".repeat(257)}),
            json!({"op":"create_channel","name":"work","source":"github"}),
            json!({"op":"list_channels","owner":"someone-else"}),
            json!({"op":"get_config","extension":"fez-github"}),
            json!({"op":"set_config","extension":"elevenlabs","value":{}}),
            json!({"op":"set_secret","key":"token","value":"x","scope":"fez-github"}),
            json!({"op":"has_secret","key":"../github.token"}),
            json!({"op":"get_secret","key":"token"}),
            json!({"op":"open_url","url":"file:///etc/passwd"}),
            json!({"op":"open_url","url":"https://ungranted.example"}),
            json!({"op":"http_request","url":"https://ungranted.example","method":"GET","headers":[],"body":null}),
        ] { assert!(ipc(&panel, "isolated_panel_request", json!({"request":request})).is_err()); }
        assert!(receive.try_recv().is_err());

        // Revocation while queued prevents the host operation from being taken.
        let view = panel.clone();
        let pending = std::thread::spawn(move || ipc(&view, "isolated_panel_request", json!({"request":{"op":"get_config","extension":"fez-elevenlabs"}})));
        let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels"]}}"#).unwrap();
        assert!(ipc(&main, "isolated_panel_host_request", json!({"id":id})).unwrap_err().to_string().contains("sign"));
        ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Ok":{"value":"must not return"}}})).unwrap();
        assert!(pending.join().unwrap().unwrap_err().to_string().contains("sign"));

        assert!(ipc(&panel, "isolated_panel_request", json!({"request":{"op":"create_channel","name":"work"}})).unwrap_err().to_string().contains("publish"));
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui"]}}"#).unwrap();
        assert!(ipc(&panel, "isolated_panel_request", json!({"request":{"op":"list_channels"}})).unwrap_err().to_string().contains("read:channels"));

        // Native close cancels waiters without waiting for the timeout.
        let view = panel.clone();
        let pending = std::thread::spawn(move || ipc(&view, "isolated_panel_request", json!({"request":{"op":"has_secret","key":"token"}})));
        let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        app.state::<PanelHost>().remove(&label);
        assert!(pending.join().unwrap().is_err());
        assert!(ipc(&main, "isolated_panel_host_request", json!({"id":id})).is_err());
        assert!(app.state::<PanelHost>().pending.lock().unwrap().is_empty());
    }

    #[test]
    fn network_requests_require_exact_https_grants_and_reject_unsafe_targets() {
        let grants = vec!["network:github.com".into(), "network:api.github.com".into()];
        assert!(allowed_url("https://github.com/login/device/code", &grants).is_ok());
        assert!(allowed_url("https://api.github.com/user", &grants).is_ok());
        for url in ["http://github.com/", "https://github.com:444/", "https://user:pass@github.com/", "https://sub.github.com/", "https://github.com.evil.example/", "https://127.0.0.1/", "https://[::1]/", "file:///tmp/key", "https://github.com./"] {
            assert!(allowed_url(url, &grants).is_err(), "{url}");
        }
        assert!(allowed_url("https://api.github.com/user", &["network:*".into()]).is_err());
        for address in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "0.0.0.0", "224.1.2.3", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::1"] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("140.82.112.3".parse().unwrap()));
        assert!(public_ip("2606:4700::1111".parse().unwrap()));
        // These fail before any DNS lookup or network activity.
        for header in ["Host", "Cookie", "Origin", "Connection", "Proxy-Authorization", "Content-Length"] {
            assert!(http_request("https://github.com", "GET", &[(header.into(), "value".into())], None).unwrap_err().contains("header"));
        }
        assert!(http_request("https://github.com", "GET", &[("Accept".into(), "text/plain\r\nInjected: yes".into())], None).is_err());
        assert!(http_request("https://github.com", "DELETE", &[], None).is_err());
        assert!(http_request("https://github.com", "POST", &[], Some(&"x".repeat(65537))).is_err());
        let response = ureq::Response::new(200, "OK", "{\"login\":\"fixture\"}").unwrap();
        assert_eq!(http_response("https://api.github.com/user", response).unwrap()["body"], "{\"login\":\"fixture\"}");
        assert!(http_response("https://github.com", ureq::Response::new(302, "Found", "").unwrap()).unwrap_err().contains("redirect"));
        assert!(http_response("https://github.com", ureq::Response::new(200, "OK", &"x".repeat(2 * 1024 * 1024 + 1)).unwrap()).unwrap_err().contains("2 MiB"));
    }

    #[test]
    fn linked_names_keep_the_existing_config_namespace_without_aliasing_other_installs() {
        let home = fixture();
        let original = home.path().join("packages/elevenlabs");
        let linked = home.path().join("packages/fez-elevenlabs");
        std::fs::rename(&original, &linked).unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"fez-elevenlabs":["ui","read:channels","sign","publish"]}}"#).unwrap();
        let host = PanelHost::new(home.path().to_owned());
        let label = host.bind("fez-elevenlabs", vec![]).unwrap();
        assert!(host.authorize(&label, &Request::GetConfig { extension: "fez-elevenlabs".into() }).is_ok());
        assert_eq!(host.scope("fez-elevenlabs").unwrap(), "fez-elevenlabs");
        assert!(host.authorize(&label, &Request::GetConfig { extension: "fez-fez-elevenlabs".into() }).is_err());
        // A second installed owner must not acquire access to the first one's data.
        std::fs::create_dir_all(&original).unwrap();
        std::fs::copy(linked.join("package.json"), original.join("package.json")).unwrap();
        assert!(host.authorize(&label, &Request::HasSecret { key: "token".into() }).is_err());
        assert!(host.scope("elevenlabs").is_err());
    }

    #[test]
    fn large_main_channel_messages_never_enter_the_shared_fetch_queue() {
        let app = mock_builder().channel_interceptor(channel_message).build(super::super::app_context()).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let panel = tauri::WebviewWindowBuilder::new(&app, "extension-panel-1", Default::default()).build().unwrap();
        let channel = "__CHANNEL__:99".parse::<tauri::ipc::JavaScriptChannelId>().unwrap().channel_on::<_, String>(main.as_ref().clone());
        channel.send("private-channel-canary".repeat(1000)).unwrap();
        for id in 0..16 {
            let mut headers = tauri::http::HeaderMap::new();
            headers.insert("Tauri-Channel-Id", id.to_string().parse().unwrap());
            let stolen = get_ipc_response(&panel, tauri::webview::InvokeRequest {
                cmd: "plugin:__TAURI_CHANNEL__|fetch".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
                url: panel.url().unwrap(), body: tauri::ipc::InvokeBody::Json(Value::Null), headers, invoke_key: INVOKE_KEY.into(),
            });
            assert!(stolen.is_err(), "a panel read another webview's channel payload");
        }
    }

}
