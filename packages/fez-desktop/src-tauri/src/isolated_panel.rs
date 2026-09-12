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
    page_view: Option<String>,
    host_requests: Option<tauri::ipc::Channel<u64>>,
    active: Arc<Semaphore>,
    appearance: String,
    details: Option<Details>,
    owner: Option<String>,
    custom: Option<Value>,
    initial_grants: Option<Vec<String>>,
    decision: Option<oneshot::Sender<bool>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Details { title: String, body: Option<String>, context: Option<String> }

pub(crate) struct PanelHost {
    home: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
    next: AtomicU64,
    generation: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
}

impl PanelHost {
    pub(crate) fn new(home: PathBuf) -> Self {
        Self { home, sessions: Mutex::new(HashMap::new()), next: AtomicU64::new(1), generation: AtomicU64::new(0), pending: Mutex::new(HashMap::new()) }
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
        sessions.insert(label.clone(), Session { name: name.into(), code, styles, agents, page_view: None, host_requests: None, active: Arc::new(Semaphore::new(16)), appearance: String::new(), details: None, owner: None, custom: None, initial_grants: None, decision: None });
        Ok(label)
    }

    fn bind_details(&self, owner: &str, details: Details) -> Result<String, String> {
        self.authorize(owner, &Request::ShowDetails { title: details.title.clone(), body: details.body.clone(), context: details.context.clone() })?;
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.values().any(|session| session.details.is_some()) { return Err("close the open details dialog first".into()); }
        let parent = sessions.get(owner).ok_or("isolated panel closed")?;
        let session = Session { name: parent.name.clone(), code: String::new(), styles: String::new(), agents: vec![], page_view: None,
            host_requests: None, active: Arc::new(Semaphore::new(2)), appearance: parent.appearance.clone(), details: Some(details), owner: Some(owner.into()), custom: None, initial_grants: None, decision: None };
        let label = format!("extension-details-{}", self.next.fetch_add(1, Ordering::Relaxed));
        sessions.insert(label.clone(), session);
        Ok(label)
    }

    fn owned_details(&self, owner: &str) -> Vec<String> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner()).iter()
            .filter(|(_, session)| session.owner.as_deref() == Some(owner)).map(|(label, _)| label.clone()).collect()
    }

    fn close<R: Runtime>(&self, app: &tauri::AppHandle<R>, label: &str) -> Result<(), String> {
        let labels = {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if sessions.remove(label).is_none() { return Err("unregistered isolated webview".into()); }
            let mut labels = vec![label.to_owned()];
            labels.extend(sessions.iter().filter(|(_, session)| session.owner.as_deref() == Some(label)).map(|(label, _)| label.clone()));
            for label in &labels { sessions.remove(label); }
            labels
        };
        self.close_labels(app, labels)
    }

    fn close_labels<R: Runtime>(&self, app: &tauri::AppHandle<R>, labels: Vec<String>) -> Result<(), String> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).retain(|_, pending| !labels.contains(&pending.label));
        let mut error = None;
        for label in labels {
            if let Some(panel) = app.get_webview(&label) {
                if let Err(failure) = panel.close() { error = Some(failure.to_string()); }
            }
        }
        error.map_or(Ok(()), Err)
    }

    fn bind_page(&self, label: &str, view: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get_mut(label).ok_or("isolated panel closed")?;
        let manifest = super::package_install::installed_manifest(&session.name, &self.home).ok_or("extension is no longer installed")?;
        if view.is_empty() || view.len() > 320 || manifest.pointer("/fez/guiRuntime").and_then(Value::as_str) != Some("isolated-page")
            || manifest.pointer("/fez/guiContributions/page/name").and_then(Value::as_str) != Some(view) {
            return Err("page view is not declared by this extension".into());
        }
        session.page_view = Some(view.into());
        Ok(())
    }

    fn remove(&self, label: &str) {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner()).remove(label);
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).retain(|_, pending| pending.label != label);
    }

    pub(crate) fn close_all<R: Runtime>(&self, app: &tauri::AppHandle<R>) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let labels = self.sessions.lock().unwrap_or_else(|p| p.into_inner()).drain().map(|(label, _)| label).collect();
        let _ = self.close_labels(app, labels);
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PanelShortcut { Escape, Palette, Settings, FocusPrevious, FocusNext }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CustomAction {
    Snapshot, StorageGet, ProcessRun, AgentSpawn, AgentStop, AgentAlive, AgentLastExit,
    PersonaList, PersonaRead, PersonaUpdate, PersonaCreate, PersonaInvite,
    EnsureChannel, ToggleReaction, OpenChannel, OpenThread, OpenGuestDm, OpenTab, Toast, Notify,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Custom { action: CustomAction, args: Value },
    ShowDetails { title: String, body: Option<String>, context: Option<String> },
    Confirm { title: String, body: Option<String>, context: Option<String> },
    CloseDetails {},
    ResolveDetails { accepted: bool },
    ReadPage {},
    SavePage { version: String, content: String },
    CommentPage { version: String, text: String, anchor: String, mentions: Vec<String> },
    HostShortcut { shortcut: PanelShortcut },
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
    Custom { name: String, action: CustomAction, args: Value, grants: Vec<String> },
    ReadPage { can_edit: bool, can_read_agents: bool },
    SavePage { version: String, content: String },
    CommentPage { version: String, text: String, anchor: String, mentions: Vec<String> },
    HostShortcut { shortcut: PanelShortcut },
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
        let (name, owner, initial_grants) = {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions.get(label).ok_or("unregistered isolated webview")?;
            if session.owner.as_ref().is_some_and(|owner| !sessions.contains_key(owner)) { return Err("details owner closed".into()); }
            (session.name.clone(), session.owner.clone(), session.initial_grants.clone())
        };
        if owner.is_some() && matches!(request, Request::CloseDetails {} | Request::ResolveDetails { accepted: false }) { return Ok(name); }
        let grants = self.grants(&name)?;
        if initial_grants.is_some_and(|initial| initial != grants) { return Err("extension permissions changed; reopen the view".into()); }
        if owner.is_some() {
            return if matches!(request, Request::Bootstrap | Request::CloseDetails {} | Request::ResolveDetails { .. }) { Ok(name) }
                else { Err("details view only supports closing".into()) };
        }
        let require = |permission: &str| -> Result<(), String> {
            if grants.iter().any(|g| g == permission) { Ok(()) }
            else { Err(format!("extension requires {permission} permission")) }
        };
        match request {
            Request::Custom { action, args } => {
                let bound = self.sessions.lock().map_err(|e| e.to_string())?.get(label).is_some_and(|session| session.custom.is_some());
                let manifest = super::package_install::installed_manifest(&name, &self.home).ok_or("extension is no longer installed")?;
                if !bound || manifest.pointer("/fez/guiRuntime").and_then(Value::as_str) != Some("isolated") { return Err("this is not an isolated custom view".into()); }
                if !args.is_object() || args.to_string().len() > 1024 * 1024 { return Err("invalid custom operation arguments".into()); }
                match action {
                    CustomAction::ProcessRun | CustomAction::AgentSpawn | CustomAction::AgentStop | CustomAction::AgentAlive | CustomAction::AgentLastExit => {
                        require("processes")?;
                        let bin = args.get("bin").and_then(Value::as_str).ok_or("an owned binary is required")?;
                        let settings = json!({"extensionPermissions": {name.clone(): grants.clone()}});
                        super::package_install::extension_may_spawn(&settings, Some(&manifest), &name, bin)?;
                    }
                    CustomAction::PersonaList | CustomAction::PersonaRead | CustomAction::PersonaUpdate | CustomAction::PersonaCreate | CustomAction::PersonaInvite => require("personas")?,
                    CustomAction::EnsureChannel | CustomAction::ToggleReaction => { require("read:channels")?; require("publish")?; }
                    CustomAction::OpenChannel | CustomAction::OpenThread => require("read:channels")?,
                    CustomAction::Notify => require("notifications")?,
                    CustomAction::OpenGuestDm => {
                        let relay = args.pointer("/guest/relay").and_then(Value::as_str).ok_or("guest relay is required")?;
                        let mut url = tauri::Url::parse(relay).map_err(|_| "invalid guest relay")?;
                        if url.scheme() != "wss" { return Err("guest relay requires WSS".into()); }
                        url.set_scheme("https").map_err(|_| "invalid guest relay")?;
                        allowed_url(url.as_str(), &grants)?;
                    }
                    _ => {}
                }
            }
            Request::CloseDetails {} | Request::ResolveDetails { .. } => return Err("this is not a details view".into()),
            Request::ShowDetails { title, body, context } | Request::Confirm { title, body, context } => {
                if title.trim().is_empty() || title.len() > 4096 || body.as_ref().is_some_and(|body| body.len() > 64 * 1024)
                    || context.as_ref().is_some_and(|context| context.len() > 256) {
                    return Err("invalid details content".into());
                }
            }
            Request::ReadPage {} | Request::SavePage { .. } | Request::CommentPage { .. } => {
                require("read:channels")?;
                let page_view = self.sessions.lock().map_err(|e| e.to_string())?.get(label).and_then(|session| session.page_view.clone()).ok_or("this panel has no document")?;
                let manifest = super::package_install::installed_manifest(&name, &self.home).ok_or("extension is no longer installed")?;
                if manifest.pointer("/fez/guiRuntime").and_then(Value::as_str) != Some("isolated-page")
                    || manifest.pointer("/fez/guiContributions/page/name").and_then(Value::as_str) != Some(page_view.as_str()) {
                    return Err("page view is no longer declared".into());
                }
                if let Request::SavePage { version, .. } | Request::CommentPage { version, .. } = request {
                    require("publish")?;
                    if version.is_empty() || version.len() > 128 { return Err("invalid document version".into()); }
                }
                if let Request::SavePage { content, .. } = request {
                    if content.len() > 1024 * 1024 { return Err("document exceeds 1 MiB".into()); }
                }
                if let Request::CommentPage { text, anchor, mentions, .. } = request {
                    if text.trim().is_empty() || text.len() > 64 * 1024 || anchor.len() > 64 * 1024 || mentions.len() > 32
                        || mentions.iter().any(|name| name.is_empty() || name.len() > 256 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))) {
                        return Err("invalid document comment".into());
                    }
                }
            }
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
        let timeout = if matches!(request, Request::Custom { action: CustomAction::ProcessRun | CustomAction::AgentSpawn, .. }) { 130 } else { 30 };
        let result = match sent {
            Ok(()) => match tokio::time::timeout(Duration::from_secs(timeout), receiver).await {
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

/// Recheck a taken request after host-side asynchronous reads, before publishing.
#[tauri::command]
pub(crate) fn isolated_panel_validate_request(host: tauri::State<'_, PanelHost>, id: u64) -> Result<(), String> {
    let pending = host.pending.lock().map_err(|e| e.to_string())?;
    let pending = pending.get(&id).ok_or("unknown or expired panel request")?;
    host.authorize(&pending.label, &pending.request).map(|_| ())
}

#[tauri::command]
pub(crate) fn isolated_panel_reply(host: tauri::State<'_, PanelHost>, id: u64, result: Result<Value, String>) -> Result<(), String> {
    let pending = host.pending.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("unknown or expired panel request")?;
    pending.reply.send(result).map_err(|_| "isolated panel closed".into())
}

#[tauri::command]
pub(crate) async fn isolated_panel_request<R: Runtime>(webview: tauri::Webview<R>, host: tauri::State<'_, PanelHost>, request: Request) -> Result<Value, String> {
    let label = webview.label();
    let name = match host.authorize(label, &request) {
        Ok(name) => name,
        Err(error) => {
            // Direct network access belongs to this custom view's initial
            // grants. A changed grant closes its sockets with the view.
            let revoked = host.sessions.lock().map_err(|e| e.to_string())?.get(label)
                .is_some_and(|session| session.initial_grants.as_ref().is_some_and(|initial| host.grants(&session.name).ok().as_ref() != Some(initial)));
            if revoked { let _ = host.close(webview.app_handle(), label); }
            return Err(error);
        }
    };
    let active = host.sessions.lock().map_err(|e| e.to_string())?.get(label).ok_or("isolated panel closed")?.active.clone();
    let permit = active.try_acquire_owned().map_err(|_| "too many pending panel requests")?;
    let scope = match &request {
        Request::GetConfig { .. } | Request::SetConfig { .. } | Request::HasSecret { .. } | Request::SetSecret { .. } => host.scope(&name)?,
        _ => String::new(),
    };
    let mut result = match &request {
        Request::Custom { action: CustomAction::StorageGet, args } => {
            let key = args.get("key").and_then(Value::as_str).ok_or("storage key is required")?;
            validate_key(key)?;
            let state = read_storage(&host.home, &name)?;
            Ok(match state.get(key) { Some(value) => json!({"value":value}), None => json!({}) })
        }
        Request::Custom { action, args } => host.forward(label, &request, HostOperation::Custom { name: name.clone(), action: action.clone(), args: args.clone(), grants: host.grants(&name)? }).await,
        Request::ShowDetails { title, body, context } => {
            open_details(&webview, &host, Details { title: title.clone(), body: body.clone(), context: context.clone() }, None)?;
            Ok(Value::Null)
        }
        Request::Confirm { title, body, context } => {
            let (decision, receiver) = oneshot::channel();
            open_details(&webview, &host, Details { title: title.clone(), body: body.clone(), context: context.clone() }, Some(decision))?;
            if !receiver.await.unwrap_or(false) { return Ok(json!(false)); }
            Ok(json!(true))
        }
        Request::CloseDetails {} | Request::ResolveDetails { .. } => {
            let owner = host.sessions.lock().map_err(|e| e.to_string())?.get(label).and_then(|session| session.owner.clone()).ok_or("details owner closed")?;
            if let Request::ResolveDetails { accepted } = request {
                if accepted { host.authorize(&owner, &Request::Bootstrap)?; }
                let decision = host.sessions.lock().map_err(|e| e.to_string())?.get_mut(label).and_then(|session| session.decision.take()).ok_or("this dialog has no pending confirmation")?;
                let _ = decision.send(accepted);
            }
            host.close(webview.app_handle(), label)?;
            if let Some(parent) = webview.app_handle().get_webview(&owner) { let _ = parent.set_focus(); }
            return Ok(Value::Null);
        }
        Request::ReadPage {} => {
            let grants = host.grants(&name)?;
            host.forward(label, &request, HostOperation::ReadPage { can_edit: grants.iter().any(|g| g == "publish"), can_read_agents: grants.iter().any(|g| g == "read:agents") }).await
        }
        Request::SavePage { version, content } => host.forward(label, &request, HostOperation::SavePage { version: version.clone(), content: content.clone() }).await,
        Request::CommentPage { version, text, anchor, mentions } => host.forward(label, &request, HostOperation::CommentPage { version: version.clone(), text: text.clone(), anchor: anchor.clone(), mentions: mentions.clone() }).await,
        Request::HostShortcut { shortcut } => {
            let main = webview.app_handle().get_webview("main").ok_or("main view unavailable")?;
            main.set_focus().map_err(|e| e.to_string())?;
            host.forward(label, &request, HostOperation::HostShortcut { shortcut: shortcut.clone() }).await
        }
        Request::ListChannels {} => host.forward(label, &request, HostOperation::ListChannels).await,
        Request::CreateChannel { name } => host.forward(label, &request, HostOperation::CreateChannel { name: name.clone() }).await,
        Request::Bootstrap => {
            let sessions = host.sessions.lock().map_err(|e| e.to_string())?;
            let session = sessions.get(label).ok_or("isolated panel closed")?;
            let grants = host.grants(&name)?;
            Ok(json!({
                "name": name, "code": session.code, "styles": session.styles,
                "pageView": session.page_view, "details": session.details.as_ref().map(|details| json!({"title":details.title,"body":details.body,"context":details.context,"confirmation":session.decision.is_some()})), "custom": session.custom,
                "client": session.details.is_none() && grants.iter().any(|g| g == "read:channels"),
                "agents": if session.details.is_none() && grants.iter().any(|g| g == "read:channels") && grants.iter().any(|g| g == "read:agents") { Some(&session.agents) } else { None },
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
    if let (Request::ReadPage {}, Ok(page)) = (&request, &mut result) {
        let grants = host.grants(&name)?;
        if !grants.iter().any(|g| g == "read:agents") { page["agents"] = Value::Null; }
        if !grants.iter().any(|g| g == "publish") { page["editable"] = json!(false); }
    }
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
    if !grants.iter().any(|grant| grant.strip_prefix("network:").is_some_and(|entry|
        entry == "*" || entry == host || (entry.starts_with('.') && (host == &entry[1..] || host.ends_with(entry))))) {
        return Err(format!("extension requires network:{host} permission"));
    }
    Ok(parsed)
}

fn network_sources(grants: &[String], relay_urls: &[String]) -> Result<String, String> {
    if grants.len() > 128 || relay_urls.len() > 32 { return Err("too many network grants".into()); }
    let mut sources = Vec::new();
    for grant in grants {
        let Some(host) = grant.strip_prefix("network:") else { continue; };
        if host == "*" { sources.extend(["https:".to_owned(), "wss:".to_owned()]); continue; }
        if host == "relay" {
            for relay in relay_urls {
                let parsed = tauri::Url::parse(relay).map_err(|_| "invalid workspace relay URL")?;
                if !matches!(parsed.scheme(), "ws" | "wss") || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() { return Err("invalid workspace relay URL".into()); }
                let origin = parsed.origin().ascii_serialization();
                sources.push(origin.clone());
                sources.push(origin.replacen("ws", "http", 1));
            }
            continue;
        }
        let domain = host.strip_prefix('.').unwrap_or(host);
        if domain.len() > 253 || !domain.contains('.') || domain.split('.').any(|label| label.is_empty() || label.len() > 63
            || label.starts_with('-') || label.ends_with('-') || !label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')) {
            return Err("invalid network grant hostname".into());
        }
        for scheme in ["https", "wss"] {
            sources.push(format!("{scheme}://{domain}"));
            if host.starts_with('.') { sources.push(format!("{scheme}://*.{domain}")); }
        }
    }
    sources.sort(); sources.dedup();
    Ok(sources.join(" "))
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

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PanelBounds { x: f64, y: f64, width: f64, height: f64 }

impl PanelBounds {
    fn clipped(&self, size: tauri::LogicalSize<f64>) -> Option<Self> {
        if ![self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite()) { return None; }
        let x = self.x.max(0.0);
        let y = self.y.max(0.0);
        let width = (self.x + self.width).min(size.width) - x;
        let height = (self.y + self.height).min(size.height) - y;
        (width > 0.0 && height > 0.0).then_some(Self { x, y, width, height })
    }

    fn rect<R: Runtime>(&self, window: &tauri::Window<R>) -> Result<tauri::Rect, String> {
        let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        // Layout can extend below a small viewport, or a resize can overtake
        // opening. Use the same clipping as updates, retaining the one-pixel
        // rounding tolerance at the native window edge.
        let bounds = self.clipped(tauri::LogicalSize::new(size.width + 1.0, size.height + 1.0))
            .ok_or("settings panel has no visible area inside the main window")?;
        Ok(tauri::Rect { position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(), size: tauri::LogicalSize::new(bounds.width, bounds.height).into() })
    }
}

fn appearance_script(appearance: &str) -> Result<String, String> {
    if appearance.len() > 8192 { return Err("panel appearance exceeds 8 KiB".into()); }
    // Host-provided CSS stays data; never interpolate it as executable code.
    Ok(format!("document.documentElement.style.cssText={};document.documentElement.dataset.embedded='true';", serde_json::to_string(appearance).unwrap()))
}

fn panel_entry<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<tauri::Url, String> {
    let mut entry: tauri::Url = if tauri::is_dev() {
        app.config().build.dev_url.clone().ok_or("missing development URL")?
    } else if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost".parse().unwrap()
    } else { "tauri://localhost".parse().unwrap() };
    entry.set_path("/isolated-panel.html");
    entry.set_query(None);
    entry.set_fragment(None);
    Ok(entry)
}

fn open_details<R: Runtime>(parent: &tauri::Webview<R>, host: &PanelHost, details: Details, decision: Option<oneshot::Sender<bool>>) -> Result<String, String> {
    let window = parent.window();
    let entry = panel_entry(parent.app_handle())?;
    let label = host.bind_details(parent.label(), details)?;
    if let Some(session) = host.sessions.lock().map_err(|e| e.to_string())?.get_mut(&label) { session.decision = decision; }
    let result = (|| {
        let appearance = host.sessions.lock().map_err(|e| e.to_string())?.get(&label).ok_or("details closed")?.appearance.clone();
        let appearance = appearance_script(&appearance)?;
        let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        // The overlay runs only Fez's fixed renderer. It receives text, never
        // extension code, arbitrary HTML, placement, or extra capabilities.
        let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::App("isolated-panel.html".into()))
            .transparent(true).auto_resize().incognito(true).focused(true).disable_drag_drop_handler()
            .initialization_script(format!("document.addEventListener('DOMContentLoaded',()=>{{{appearance}document.documentElement.dataset.surface='details';}},{{once:true}});"))
            .on_navigation(move |url| url == &entry)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
        window.add_child(builder, tauri::LogicalPosition::new(0.0, 0.0), size).map_err(|e| e.to_string())?;
        host.authorize(&label, &Request::Bootstrap)?;
        Ok(label.clone())
    })();
    if result.is_err() {
        host.remove(&label);
        if let Some(overlay) = parent.app_handle().get_webview(&label) { let _ = overlay.close(); }
    }
    result
}

#[tauri::command]
pub(crate) async fn open_isolated_panel<R: Runtime>(webview: tauri::Webview<R>, app: tauri::AppHandle<R>, host: tauri::State<'_, PanelHost>, name: String, agents: Vec<(String, String)>, host_requests: Option<tauri::ipc::JavaScriptChannelId>, bounds: PanelBounds, appearance: String, page_view: Option<String>, custom: Option<Value>, relay_urls: Option<Vec<String>>) -> Result<String, String> {
    let generation = host.generation.load(Ordering::SeqCst);
    if !cfg!(target_os = "macos") { return Err("isolated settings currently require macOS".into()); }
    let window = webview.window();
    let rect = bounds.rect(&window)?;
    let script = appearance_script(&appearance)?;
    let entry = panel_entry(&app)?;
    let initial_grants = if custom.is_some() { Some(host.grants(&name)?) } else { None };
    let network = if let Some(custom) = &custom {
        // The dev server bypasses Tauri's per-view asset response hook. Never
        // silently launch a custom view with a different network boundary.
        if tauri::is_dev() { return Err("Custom extension views require a packaged macOS build".into()); }
        if page_view.is_some() || !custom.is_object() || custom.to_string().len() > 1024 * 1024
            || !matches!(custom.get("kind").and_then(Value::as_str), Some("settings" | "nav" | "navTab" | "navSummary" | "thread" | "message" | "profile")) {
            return Err("invalid custom surface".into());
        }
        let manifest = super::package_install::installed_manifest(&name, &host.home).ok_or("extension is no longer installed")?;
        if manifest.pointer("/fez/guiRuntime").and_then(Value::as_str) != Some("isolated") { return Err("extension does not declare an isolated custom GUI".into()); }
        Some(network_sources(initial_grants.as_ref().unwrap(), &relay_urls.unwrap_or_default())?)
    } else { None };
    let label = host.bind(&name, agents)?;
    if let Some(view) = page_view {
        if let Err(error) = host.bind_page(&label, &view) { host.remove(&label); return Err(error); }
    }
    {
        let mut sessions = host.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get_mut(&label).ok_or("isolated panel closed")?;
        session.host_requests = host_requests.map(|id| id.channel_on(webview));
        session.appearance = appearance;
        session.custom = custom;
        session.initial_grants = initial_grants;
    }
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::App("isolated-panel.html".into()))
        .incognito(true).focused(false).disable_drag_drop_handler()
        .initialization_script(format!("document.addEventListener('DOMContentLoaded',()=>{{{script}}},{{once:true}});"))
        .on_web_resource_request(move |request, response| {
            // Modify only this child's own entry document. Other views keep
            // the restrictive settings policy, even for the same asset URL.
            if request.uri().path() == "/isolated-panel.html" {
                if let Some(network) = &network {
                    if let Ok(html) = std::str::from_utf8(response.body()) {
                        let html = html.replace("connect-src ipc: http://ipc.localhost", &format!("connect-src ipc: http://ipc.localhost {network}"))
                            .replace("img-src 'self' data:", &format!("img-src 'self' data: {network}"))
                            .replace("media-src 'none'", &format!("media-src 'self' data: {network}"));
                        *response.body_mut() = std::borrow::Cow::Owned(html.into_bytes());
                    }
                }
            }
        })
        .on_navigation(move |url| url == &entry)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    match window.add_child(builder, rect.position, rect.size) {
        Ok(panel) => {
            // A main navigation can revoke the session while creation is queued.
            if host.generation.load(Ordering::SeqCst) != generation {
                let _ = panel.close();
                host.remove(&label);
                return Err("main view navigated while opening settings".into());
            }
            if let Err(error) = host.authorize(&label, &Request::Bootstrap) {
                let _ = panel.close();
                host.remove(&label);
                return Err(error);
            }
            Ok(label)
        }
        Err(error) => { host.remove(&label); Err(error.to_string()) }
    }
}

#[tauri::command]
pub(crate) fn update_isolated_panel<R: Runtime>(app: tauri::AppHandle<R>, host: tauri::State<'_, PanelHost>, label: String, bounds: PanelBounds, appearance: String, visible: bool, focus: Option<bool>, page_changed: Option<bool>) -> Result<(), String> {
    // Only the main caller reaches this command. Labels must still belong to
    // live panel sessions; arbitrary webviews cannot be moved or styled.
    let panel = app.get_webview(&label).ok_or("isolated panel closed")?;
    if let Err(error) = host.authorize(&label, &Request::Bootstrap) { let _ = host.close(&app, &label); return Err(error); }
    let script = appearance_script(&appearance)?;
    host.sessions.lock().map_err(|e| e.to_string())?.get_mut(&label).ok_or("isolated panel closed")?.appearance = appearance;
    let details = host.owned_details(&label);
    for child in &details {
        if let Some(overlay) = app.get_webview(child) {
            if !visible { let _ = overlay.hide(); }
            else {
                let window = overlay.window();
                overlay.set_bounds(tauri::Rect { position: tauri::PhysicalPosition::new(0, 0).into(), size: window.inner_size().map_err(|e| e.to_string())?.into() }).map_err(|e| e.to_string())?;
                overlay.eval(&script).map_err(|e| e.to_string())?;
                overlay.show().map_err(|e| e.to_string())?;
            }
        }
    }
    if page_changed == Some(true) && host.authorize(&label, &Request::ReadPage {}).is_ok() {
        panel.eval("window.dispatchEvent(new Event('fez:page-changed'));").map_err(|e| e.to_string())?;
    }
    if page_changed == Some(true) && host.authorize(&label, &Request::Custom { action: CustomAction::Snapshot, args: json!({}) }).is_ok() {
        panel.eval("window.dispatchEvent(new Event('fez-custom-changed'));").map_err(|e| e.to_string())?;
    }
    if !visible { return panel.hide().map_err(|e| e.to_string()); }
    // A resize can overtake a DOM measurement. Clip to the current viewport
    // without destroying the panel's in-progress form or login state.
    let window = panel.window();
    let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
    let Some(bounds) = bounds.clipped(size) else { return panel.hide().map_err(|e| e.to_string()); };
    let rect = tauri::Rect { position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(), size: tauri::LogicalSize::new(bounds.width, bounds.height).into() };
    panel.set_bounds(rect).map_err(|e| e.to_string())?;
    panel.eval(script).map_err(|e| e.to_string())?;
    panel.show().map_err(|e| e.to_string())?;
    if focus == Some(true) && details.is_empty() {
        panel.set_focus().map_err(|e| e.to_string())?;
        panel.eval("[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].find(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length)?.focus();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn close_isolated_panel<R: Runtime>(app: tauri::AppHandle<R>, host: tauri::State<'_, PanelHost>, label: String) -> Result<(), String> {
    if !host.sessions.lock().map_err(|e| e.to_string())?.contains_key(&label) { return Err("unregistered isolated webview".into()); }
    // Revoke before closing, including when the native close itself fails.
    host.close(&app, &label)
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
    fn stale_resize_bounds_clip_without_discarding_panel_state() {
        let bounds = PanelBounds { x: 240.0, y: 180.0, width: 600.0, height: 500.0 };
        let clipped = bounds.clipped(tauri::LogicalSize::new(700.0, 500.0)).unwrap();
        assert_eq!((clipped.x, clipped.y, clipped.width, clipped.height), (240.0, 180.0, 460.0, 320.0));
        assert!(bounds.clipped(tauri::LogicalSize::new(200.0, 100.0)).is_none());
        assert!(PanelBounds { x: f64::NAN, ..bounds }.clipped(tauri::LogicalSize::new(700.0, 500.0)).is_none());
    }

    #[test]
    fn details_are_bounded_host_content_with_only_close_authority() {
        let home = fixture();
        let host = PanelHost::new(home.path().to_owned());
        let parent = host.bind("elevenlabs", vec![]).unwrap();
        let details = Details { title: "Card title".into(), body: Some("Full details".into()), context: Some("Backlog".into()) };
        for invalid in [Details { title: " ".into(), ..details.clone() }, Details { title: "x".repeat(4097), ..details.clone() },
            Details { body: Some("x".repeat(65537)), ..details.clone() }, Details { context: Some("x".repeat(257)), ..details.clone() }] {
            assert!(host.bind_details(&parent, invalid).is_err());
        }
        let label = host.bind_details(&parent, details.clone()).unwrap();
        assert!(host.authorize(&label, &Request::Bootstrap).is_ok());
        assert!(host.authorize(&label, &Request::CloseDetails {}).is_ok());
        assert!(host.authorize(&parent, &Request::CloseDetails {}).is_err());
        assert!(host.authorize(&label, &Request::GetPreference { key: "voices".into() }).is_err());
        assert!(host.bind_details(&label, details.clone()).is_err());
        assert!(host.bind_details(&parent, details).is_err());
        let sessions = host.sessions.lock().unwrap();
        assert!(sessions[&label].code.is_empty());
        assert!(sessions[&label].styles.is_empty());
        assert!(sessions[&label].agents.is_empty());
        drop(sessions);
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":[]}}"#).unwrap();
        assert!(host.authorize(&label, &Request::Bootstrap).is_err());
        assert!(host.authorize(&label, &Request::CloseDetails {}).is_ok(), "revocation cannot trap the dialog");
        host.remove(&parent);
        assert!(host.authorize(&label, &Request::Bootstrap).is_err());
        assert!(serde_json::from_value::<Request>(json!({"op":"show_details","title":"x","html":"<script>"})).is_err());
    }

    #[test]
    fn custom_operations_bind_identity_owned_bins_and_live_permissions() {
        let home = fixture();
        std::fs::write(home.path().join("packages/elevenlabs/package.json"), r#"{"bin":{"own-cli":"cli.js"},"fez":{"parts":{"gui":"gui.js"},"guiRuntime":"isolated"}}"#).unwrap();
        let grants = vec!["ui".into(), "read:channels".into(), "processes".into()];
        std::fs::write(home.path().join("settings.json"), json!({"extensionPermissions":{"elevenlabs":grants}}).to_string()).unwrap();
        let host = PanelHost::new(home.path().to_owned());
        let label = host.bind("elevenlabs", vec![]).unwrap();
        let run = |bin: &str| Request::Custom { action: CustomAction::ProcessRun, args: json!({"bin":bin,"args":["status"]}) };
        assert!(host.authorize(&label, &run("own-cli")).is_err(), "settings sessions cannot borrow custom operations");
        {
            let mut sessions = host.sessions.lock().unwrap();
            let session = sessions.get_mut(&label).unwrap();
            session.custom = Some(json!({"kind":"settings"})); session.initial_grants = Some(grants.clone());
        }
        assert_eq!(host.authorize(&label, &run("own-cli")).unwrap(), "elevenlabs");
        for bin in ["../own-cli", "/bin/sh", "another-cli", "fez-agent"] { assert!(host.authorize(&label, &run(bin)).is_err()); }
        for action in [CustomAction::AgentStop, CustomAction::AgentAlive, CustomAction::AgentLastExit] {
            assert!(host.authorize(&label, &Request::Custom { action, args: json!({"name":"fez","bin":"fez-agent"}) }).is_err());
        }
        for action in [CustomAction::PersonaRead, CustomAction::ToggleReaction, CustomAction::Notify] {
            assert!(host.authorize(&label, &Request::Custom { action, args: json!({}) }).is_err());
        }
        assert!(serde_json::from_value::<Request>(json!({"op":"custom","action":"sign_event","args":{}})).is_err());
        assert!(serde_json::from_value::<Request>(json!({"op":"custom","action":"process_run","args":{},"name":"victim"})).is_err());
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels"]}}"#).unwrap();
        assert!(host.authorize(&label, &Request::Bootstrap).unwrap_err().contains("permissions changed"));
    }

    #[test]
    fn custom_network_policy_cannot_inject_sources_or_expand_subdomains() {
        let sources = network_sources(&["network:.fez.chat".into(), "network:api.base.org".into()], &[]).unwrap();
        assert!(sources.contains("wss://*.fez.chat"));
        assert!(sources.contains("https://fez.chat"));
        assert!(sources.contains("https://api.base.org"));
        assert!(!sources.contains("*.api.base.org"));
        for host in ["x.com; script-src *", "x.com/path", "x.com:443", "x..com", "*x.com", "x.com'", "x.com."] {
            assert!(network_sources(&[format!("network:{host}")], &[]).is_err());
        }
        let relay = network_sources(&["network:relay".into()], &["ws://127.0.0.1:7777/path".into()]).unwrap();
        assert!(relay.contains("ws://127.0.0.1:7777"));
        assert!(relay.contains("http://127.0.0.1:7777"));
        assert!(!relay.contains("/path"));
        assert!(network_sources(&["network:relay".into()], &["file:///etc/passwd".into()]).is_err());
    }

    #[test]
    fn confirmation_resolves_only_from_its_host_view_and_close_cancels() {
        let home = fixture();
        let host = PanelHost::new(home.path().to_owned());
        let parent = host.bind("elevenlabs", vec![]).unwrap();
        let details = Details { title: "Confirm action".into(), body: Some("Review the effect".into()), context: None };
        let label = host.bind_details(&parent, details.clone()).unwrap();
        let (decision, mut answer) = oneshot::channel();
        host.sessions.lock().unwrap().get_mut(&label).unwrap().decision = Some(decision);
        let app = mock_builder().manage(host).invoke_handler(guard(tauri::generate_handler![isolated_panel_request]))
            .build(super::super::app_context()).unwrap();
        let parent_view = tauri::WebviewWindowBuilder::new(&app, &parent, Default::default()).build().unwrap();
        let details_view = tauri::WebviewWindowBuilder::new(&app, &label, Default::default()).build().unwrap();
        let bootstrap = ipc(&details_view, "isolated_panel_request", json!({"request":{"op":"bootstrap"}})).unwrap();
        assert_eq!(bootstrap["details"]["confirmation"], true);
        assert_eq!(bootstrap["code"], ""); assert_eq!(bootstrap["client"], false);
        let accepted = json!({"request":{"op":"resolve_details","accepted":true}});
        assert!(ipc(&parent_view, "isolated_panel_request", accepted.clone()).is_err());
        assert!(answer.try_recv().is_err());
        ipc(&details_view, "isolated_panel_request", accepted).unwrap();
        assert_eq!(answer.try_recv().unwrap(), true);
        let host = app.state::<PanelHost>();
        let next = host.bind_details(&parent, details).unwrap();
        let (decision, mut answer) = oneshot::channel();
        host.sessions.lock().unwrap().get_mut(&next).unwrap().decision = Some(decision);
        host.close(app.handle(), &parent).unwrap();
        assert_eq!(answer.try_recv(), Err(oneshot::error::TryRecvError::Closed));
        assert!(host.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn page_requests_need_a_bound_document_and_live_grants() {
        let home = fixture();
        let host = PanelHost::new(home.path().to_owned());
        let label = host.bind("elevenlabs", vec![]).unwrap();
        assert!(host.authorize(&label, &Request::ReadPage {}).is_err());
        assert!(host.bind_page(&label, "Board").is_err());
        let manifest = home.path().join("packages/elevenlabs/package.json");
        std::fs::write(&manifest, r#"{"fez":{"parts":{"gui":"gui.js"},"guiRuntime":"isolated-page","guiContributions":{"page":{"name":"Board"}}}}"#).unwrap();
        assert!(host.bind_page(&label, "Another view").is_err());
        host.bind_page(&label, "Board").unwrap();
        assert!(host.authorize(&label, &Request::ReadPage {}).is_ok());
        let save = Request::SavePage { version: "v1".into(), content: "updated document".into() };
        assert!(host.authorize(&label, &save).unwrap_err().contains("publish"));
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels","publish"]}}"#).unwrap();
        assert!(host.authorize(&label, &save).is_ok());
        assert!(host.authorize(&label, &Request::SavePage { version: String::new(), content: "x".into() }).is_err());
        assert!(host.authorize(&label, &Request::SavePage { version: "v1".into(), content: "x".repeat(1024 * 1024 + 1) }).is_err());
        assert!(host.authorize(&label, &Request::CommentPage { version: "v1".into(), text: "Assign".into(), anchor: "card".into(), mentions: vec!["fez".into()] }).is_ok());
        for op in ["read_page", "save_page", "comment_page"] {
            assert!(serde_json::from_value::<Request>(json!({"op":op,"channelId":"victim","slug":"secret","version":"v1","content":"overwrite"})).is_err());
        }
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","publish"]}}"#).unwrap();
        assert!(host.authorize(&label, &save).unwrap_err().contains("read:channels"));
        host.remove(&label);
        assert!(host.authorize(&label, &Request::ReadPage {}).is_err());
    }

    #[test]
    fn settings_panel_is_a_child_of_main_and_keeps_its_own_caller_identity() {
        let home = fixture();
        let app = mock_builder().manage(PanelHost::new(home.path().to_owned()))
            .invoke_handler(guard(tauri::generate_handler![open_isolated_panel, update_isolated_panel, close_isolated_panel, isolated_panel_request]))
            .build(super::super::app_context()).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        // MockRuntime reports a zero-sized native window. The bundled probe
        // covers real dimensions; this one-pixel rect fits rounding tolerance.
        let bounds = json!({"x":0,"y":0,"width":1,"height":1});
        let result = ipc(&main, "open_isolated_panel", json!({"name":"elevenlabs","agents":[],"bounds":bounds,"appearance":"--bg0: #fff; color-scheme: light;"})).unwrap();
        assert!(result.is_string(), "opening must return the owned child label for cleanup");
        let children = main.as_ref().window().webviews();
        assert_eq!(children.len(), 2, "settings must not open another window");
        let panel = children.iter().find(|view| view.label() == result.as_str().unwrap()).unwrap();
        assert_eq!(panel.window().label(), "main");
        struct View<'a>(&'a tauri::Webview<tauri::test::MockRuntime>);
        impl AsRef<tauri::Webview<tauri::test::MockRuntime>> for View<'_> {
            fn as_ref(&self) -> &tauri::Webview<tauri::test::MockRuntime> { self.0 }
        }
        let denied = get_ipc_response(&View(panel), tauri::webview::InvokeRequest {
            cmd: "get_identity".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
            url: panel.url().unwrap(), body: tauri::ipc::InvokeBody::Json(json!({})),
            headers: Default::default(), invoke_key: INVOKE_KEY.into(),
        });
        assert!(denied.is_err(), "sharing the window must not share main's authority");
        assert!(ipc(&main, "update_isolated_panel", json!({"label":"main","bounds":bounds,"appearance":"","visible":true})).is_err());
        assert!(ipc(&main, "close_isolated_panel", json!({"label":"main"})).is_err());
        ipc(&main, "update_isolated_panel", json!({"label":result,"bounds":{"x":-1,"y":0,"width":1,"height":1},"appearance":"","visible":true})).unwrap();
        assert!(app.state::<PanelHost>().authorize(result.as_str().unwrap(), &Request::Bootstrap).is_ok());
        ipc(&main, "update_isolated_panel", json!({"label":result,"bounds":bounds,"appearance":"","visible":false})).unwrap();
        ipc(&main, "close_isolated_panel", json!({"label":result})).unwrap();
        assert!(app.state::<PanelHost>().authorize(result.as_str().unwrap(), &Request::Bootstrap).is_err());
        assert_eq!(main.as_ref().window().webviews().len(), 1);
        let reopened = ipc(&main, "open_isolated_panel", json!({"name":"elevenlabs","agents":[],"bounds":bounds,"appearance":""})).unwrap();
        app.state::<PanelHost>().close_all(app.handle());
        assert_eq!(main.as_ref().window().webviews().len(), 1);
        assert!(app.state::<PanelHost>().authorize(reopened.as_str().unwrap(), &Request::Bootstrap).is_err());
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
        let app = mock_builder().manage(host).invoke_handler(guard(tauri::generate_handler![isolated_panel_request, isolated_panel_reply, isolated_panel_host_request, isolated_panel_validate_request]))
            .build(super::super::app_context()).unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let panel = tauri::WebviewWindowBuilder::new(&app, &label, Default::default()).build().unwrap();
        for (request, expected, answer) in [
            (json!({"op":"host_shortcut","shortcut":"escape"}), json!({"op":"host_shortcut","shortcut":"escape"}), Value::Null),
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
            assert!(ipc(&panel, "isolated_panel_validate_request", json!({"id":id})).is_err());
            ipc(&main, "isolated_panel_validate_request", json!({"id":id})).unwrap();
            assert!(ipc(&main, "isolated_panel_host_request", json!({"id":id})).is_err());
            ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Ok":answer}})).unwrap();
            assert_eq!(pending.join().unwrap(), Ok(answer));
            assert!(ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Ok":null}})).is_err());
            assert!(ipc(&main, "isolated_panel_validate_request", json!({"id":id})).is_err());
        }
        for request in [
            json!({"op":"host_shortcut","shortcut":"get_identity"}),
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

        // Revocation after dispatch prevents committing the in-flight operation.
        let view = panel.clone();
        let pending = std::thread::spawn(move || ipc(&view, "isolated_panel_request", json!({"request":{"op":"create_channel","name":"work"}})));
        let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        ipc(&main, "isolated_panel_host_request", json!({"id":id})).unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels","sign"]}}"#).unwrap();
        assert!(ipc(&main, "isolated_panel_validate_request", json!({"id":id})).unwrap_err().to_string().contains("publish"));
        ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Err":"revoked"}})).unwrap();
        assert!(pending.join().unwrap().is_err());

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

        // Optional read capabilities can be revoked while main prepares a snapshot.
        std::fs::write(home.path().join("packages/elevenlabs/package.json"), r#"{"fez":{"parts":{"gui":"gui.js"},"guiRuntime":"isolated-page","guiContributions":{"page":{"name":"Board"}}}}"#).unwrap();
        app.state::<PanelHost>().bind_page(&label, "Board").unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels","read:agents","publish"]}}"#).unwrap();
        let view = panel.clone();
        let pending = std::thread::spawn(move || ipc(&view, "isolated_panel_request", json!({"request":{"op":"read_page"}})));
        let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(ipc(&main, "isolated_panel_host_request", json!({"id":id})), Ok(json!({"op":"read_page","can_edit":true,"can_read_agents":true})));
        std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"elevenlabs":["ui","read:channels"]}}"#).unwrap();
        ipc(&main, "isolated_panel_reply", json!({"id":id,"result":{"Ok":{"content":"Board","editable":true,"agents":[["worker","fez"]]}}})).unwrap();
        assert_eq!(pending.join().unwrap(), Ok(json!({"content":"Board","editable":false,"agents":null})));

        // Native close cancels waiters without waiting for the timeout.
        let view = panel.clone();
        let pending = std::thread::spawn(move || ipc(&view, "isolated_panel_request", json!({"request":{"op":"has_secret","key":"token"}})));
        let id = receive.recv_timeout(Duration::from_secs(3)).unwrap();
        app.state::<PanelHost>().remove(&label);
        assert!(pending.join().unwrap().is_err());
        assert!(ipc(&main, "isolated_panel_host_request", json!({"id":id})).is_err());
        assert!(ipc(&main, "isolated_panel_validate_request", json!({"id":id})).is_err());
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
        assert!(allowed_url("https://api.github.com/user", &["network:*".into()]).is_ok());
        assert!(allowed_url("https://api.github.com/user", &["network:.github.com".into()]).is_ok());
        assert!(allowed_url("https://github.com.evil.example/user", &["network:.github.com".into()]).is_err());
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
