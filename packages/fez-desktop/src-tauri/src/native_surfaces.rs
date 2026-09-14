//! Native surface lifetime and owner grants for the CEF-enabled desktop build.
use cef::{ImplBrowser, ImplBrowserHost};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Write}, os::unix::{fs::{OpenOptionsExt, PermissionsExt}, net::UnixListener}, path::PathBuf, sync::{Arc, Mutex}, time::Duration};
use tauri::{Emitter, Manager, WebviewUrl, webview::{NewWindowResponse, PermissionResponse}};
use tauri_runtime_cef::{allocate_devtools_message_id, Cef, DevToolsProtocol, FrameEventKind, RuntimeStyle,
    SandboxPolicy, SecretStorage, WebviewBuilderCefExt, WebviewCefExt, WebviewWindowBuilderCefExt};
use tokio::sync::{oneshot, watch};
use super::isolated_panel::{self, PanelBounds};
#[path = "native_cursor.rs"]
mod cursor;
#[path = "native_surface_queue.rs"]
mod ownership;
use ownership::{Queue, TurnState};

const TIMEOUT: Duration = Duration::from_secs(5);

const OWNER_URL: &str = "http://tauri.localhost/owner.html";
type Replies = Mutex<HashMap<i32, oneshot::Sender<Result<Value, String>>>>;
// Descriptors are capabilities for one named local persona, never the owner API.
fn valid_agent_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
struct Grant { persona: String, token: String }
impl Grant {
    fn new(persona: &str) -> Result<Self, String> {
        if !valid_agent_name(persona) { return Err("invalid local agent".into()); }
        Ok(Self { persona: persona.into(), token: random_hex()? })
    }
}
struct Host {
    surfaces: Mutex<HashMap<String, Arc<Surface>>>, lifecycle: tokio::sync::Mutex<()>,
    published: Mutex<HashMap<String, String>>, routes: Mutex<HashMap<(String, String), String>>,
    next_label: std::sync::atomic::AtomicUsize, profile: PathBuf, lab: bool,
}
struct Surface { id: String, label: String, token: String, app: tauri::AppHandle, state: Mutex<Control>, input: tokio::sync::Mutex<()>, replies: Replies, changed: watch::Sender<()> }
struct Control { mode: &'static str, epoch: u64, visible: bool, viewport: Option<(f64, f64)>, url: String, title: String, back: bool, forward: bool,
    grants: HashMap<String, Grant>, queue: Queue, queued: bool, driver: Option<String> }
impl Control {
    fn revoke(&mut self, mode: &'static str) {
        self.epoch += 1; self.mode = mode; self.viewport = None; self.driver = None;
        if mode != "agent" { self.queue.paused = true; }
        if mode == "stopped" { self.grants.clear(); self.queue.clear(); }
    }
    fn advance(&mut self) -> bool {
        let driver = if self.visible { self.queue.driver().map(str::to_owned) } else { None };
        if self.driver == driver { return false; }
        self.driver = driver; self.mode = if self.driver.is_some() { "agent" } else { "human" };
        self.epoch += 1; self.viewport = None;
        true
    }
    fn check(&self, epoch: u64) -> Result<(), String> {
        if self.mode != "agent" || !self.visible || self.epoch != epoch { Err("Control changed; ask the owner and observe again".into()) } else { Ok(()) }
    }
    fn expire(&mut self, epoch: u64) -> bool {
        if self.epoch != epoch { return false; }
        self.revoke("human");
        true
    }
}
impl Surface {
    fn browser_label(&self) -> String { format!("browser-{}", self.id) }
    fn owner_label(&self) -> String { format!("surface-owner-{}", self.id) }
    fn browser(&self) -> Result<tauri::Webview, String> { self.app.get_webview(&self.browser_label()).ok_or("browser is closed".into()) }
    fn snapshot(&self) -> Value {
        let s = self.state.lock().unwrap();
        json!({"id": self.id, "label": self.label, "mode": s.mode, "epoch": s.epoch, "url": s.url, "title": s.title, "canGoBack": s.back, "canGoForward": s.forward,
            "agentName": s.driver, "queued": s.queued, "paused": s.queue.paused, "waiting": s.queue.waiting(), "waitingEntries": s.queue.waiting_entries().into_iter().map(|(request,persona)| json!({"request":request,"persona":persona})).collect::<Vec<_>>()})
    }
    fn revoke(&self, mode: &'static str) { self.state.lock().unwrap().revoke(mode); self.hide_cursor(); self.changed.send_replace(()); }
    fn owner_navigation(&self) {
        let mut s = self.state.lock().unwrap();
        if s.mode == "agent" || !s.queue.is_empty() { s.revoke("human"); }
        else { s.epoch += 1; s.viewport = None; }
        self.hide_cursor(); self.changed.send_replace(());
    }
    fn hide_cursor(&self) { let id = self.id.clone(); let _ = self.app.run_on_main_thread(move || cursor::hide(&id)); }
    fn check(&self, epoch: u64) -> Result<(), String> { self.state.lock().unwrap().check(epoch) }
    fn expire(&self, epoch: u64) {
        if self.state.lock().unwrap().expire(epoch) { self.hide_cursor(); self.changed.send_replace(()); }
    }
    async fn paint_cursor<T: Send + 'static>(self: &Arc<Self>, epoch: u64, paint: impl FnOnce(&str) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (send, recv) = oneshot::channel();
        let surface = self.clone();
        self.app.run_on_main_thread(move || {
            let state = surface.state.lock().unwrap();
            let _ = send.send(state.check(epoch).and_then(|()| paint(&surface.id)));
        }).map_err(|e| e.to_string())?;
        match tokio::time::timeout(TIMEOUT, recv).await {
            Ok(Ok(result)) => result,
            _ => { self.expire(epoch); Err("cursor timed out or browser closed".into()) }
        }
    }
    async fn move_cursor(self: &Arc<Self>, epoch: u64, x: f64, y: f64, viewport: (f64,f64)) -> Result<(), String> {
        let label = self.state.lock().unwrap().driver.as_ref().map_or("Agent".into(), |name| format!("@{name}"));
        let ((from_x,from_y), reduced) = self.paint_cursor(epoch, move |id| cursor::begin(id,viewport,label)).await?;
        for step in 1..=10 {
            let t = if reduced { 1. } else { let t = f64::from(step)/10.; t*t*(3.-2.*t) };
            self.paint_cursor(epoch, move |id| { cursor::move_to(id,from_x+(x-from_x)*t,from_y+(y-from_y)*t); Ok(()) }).await?;
            tokio::time::sleep(Duration::from_millis(18)).await;
        }
        self.rpc("Input.dispatchMouseEvent", json!({"type":"mouseMoved","x":x,"y":y}), Some(epoch)).await?;
        Ok(())
    }
    async fn rpc(self: &Arc<Self>, method: &str, params: Value, epoch: Option<u64>) -> Result<Value, String> {
        let child = self.browser()?;
        let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
        let click = method == "Input.dispatchMouseEvent" && params["type"] == "mousePressed";
        let message = json!({"id": id, "method": method, "params": params}).to_string();
        let (send, recv) = oneshot::channel();
        { let mut pending = self.replies.lock().unwrap();
          if pending.len() >= 16 { return Err("too many browser requests".into()); }
          pending.insert(id, send); }
        let surface = self.clone();
        // Check on CEF's UI thread, immediately before dispatch. Takeover never
        // waits for the agent's socket or for queued native input to finish.
        let dispatch = child.with_cef_webview(move |view| {
            let state = surface.state.lock().unwrap();
            let result = epoch.map_or(Ok(()), |epoch| state.check(epoch)).and_then(|()| {
                let host = view.browser().host().ok_or("browser has no native host")?;
                if epoch.is_some() {
                    let native = unsafe { objc2::rc::Retained::<objc2_app_kit::NSView>::retain(host.window_handle().cast()) }.ok_or("native browser is closed")?;
                    if native.isHiddenOrHasHiddenAncestor() || !native.window().is_some_and(|w| w.isVisible() && !w.isMiniaturized()) {
                        return Err("browser is not visible".into());
                    }
                }
                if host.send_dev_tools_message(Some(message.as_bytes())) != 1 { return Err("native browser refused input".into()); }
                if click {
                    cursor::press(&surface.id);
                    let app = surface.app.clone();
                    let cursor_id = surface.id.clone();
                    tauri::async_runtime::spawn(async move { for _ in 0..16 {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        let id = cursor_id.clone();
                        let _ = app.run_on_main_thread(move || cursor::redraw(&id));
                    } });
                }
                Ok(())
            });
            drop(state);
            if let Err(error) = result { if let Some(reply) = surface.replies.lock().unwrap().remove(&id) { let _ = reply.send(Err(error)); } }
        });
        let result = match dispatch {
            Err(e) => Err(e.to_string()),
            Ok(()) => match tokio::time::timeout(TIMEOUT, recv).await {
                Ok(Ok(result)) => result,
                _ => {
                    // A queued CEF callback must lose permission before this
                    // action releases its input lock and reports failure.
                    if let Some(epoch) = epoch { self.expire(epoch); }
                    Err("browser request timed out or closed".into())
                },
            },
        };
        self.replies.lock().unwrap().remove(&id);
        if let Some(epoch) = epoch { self.check(epoch)?; }
        result
    }
}
fn surfaces(app: &tauri::AppHandle) -> Vec<Arc<Surface>> { app.state::<Host>().surfaces.lock().unwrap().values().cloned().collect() }
fn current(app: &tauri::AppHandle, id: Option<&str>) -> Result<Arc<Surface>, String> {
    let host = app.state::<Host>(); let sessions = host.surfaces.lock().unwrap();
    if let Some(id) = id { return sessions.get(id).cloned().ok_or("browser is closed".into()); }
    if sessions.len() > 1 { return Err("Choose a browser target before input".into()); }
    sessions.values().next().cloned().ok_or("browser is closed".into())
}
fn publish_catalogs(app: &tauri::AppHandle) -> Result<(), String> {
    let host = app.state::<Host>();
    // Serialize complete catalogs so a concurrent close cannot resurrect a target.
    let mut published = host.published.lock().unwrap();
    let mut catalogs: HashMap<String, Vec<Value>> = HashMap::new();
    for surface in surfaces(app) {
        let state = surface.state.lock().unwrap();
        if state.mode == "stopped" { continue; }
        for grant in state.grants.values() {
            catalogs.entry(grant.persona.clone()).or_default().push(json!({
                "version":1,"id":surface.id,"kind":"browser","label":surface.label,
                "endpoint":format!("unix://{}",host.profile.join("control.sock").display()),"agentToken":grant.token
            }));
        }
    }
    for name in published.keys().filter(|name| !catalogs.contains_key(*name)).cloned().collect::<Vec<_>>() {
        match std::fs::remove_file(host.profile.join(format!("{name}.json"))) {
            Ok(()) => (), Err(e) if e.kind() == std::io::ErrorKind::NotFound => (), Err(e) => return Err(e.to_string()),
        }
        published.remove(&name);
    }
    for (name, mut targets) in catalogs {
        targets.sort_by(|a,b| a["label"].as_str().cmp(&b["label"].as_str()));
        let data = json!({"version":2,"targets":targets}).to_string();
        if published.get(&name) == Some(&data) { continue; }
        let temp = host.profile.join(format!(".{name}-{}.tmp", random_hex()?));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
            file.write_all(data.as_bytes())?;
            std::fs::rename(&temp,host.profile.join(format!("{name}.json")))
        })();
        if let Err(error) = result { let _ = std::fs::remove_file(temp); return Err(error.to_string()); }
        published.insert(name,data);
    }
    Ok(())
}
fn random_hex() -> Result<String, String> { let mut bytes = [0u8; 24]; getrandom::fill(&mut bytes).map_err(|e| e.to_string())?; Ok(hex::encode(bytes)) }
fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeTurn { id: String, order: Vec<String>, state: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeContext { version: u32, persona: String, pid: u32, tools: Vec<String>, #[serde(rename="updatedAt")] updated_at: u64, turn: Option<RuntimeTurn> }
fn runtime_home(host: &Host) -> PathBuf { if host.lab { host.profile.join(".fez") } else { host.profile.parent().unwrap().to_path_buf() } }
// Keep existing development attachments valid after the Browser Use rename.
fn attached(context: &RuntimeContext) -> bool { context.tools.iter().any(|name| matches!(name.as_str(), "browser-use" | "computer-use")) }
fn local_persona(host: &Host, name: &str) -> bool { valid_agent_name(name) && runtime_home(host).join("personas").join(format!("{name}.md")).is_file() }
fn runtime_contexts(host: &Host) -> HashMap<String, RuntimeContext> {
    let directory = runtime_home(host).join("agent-runtime");
    let mut contexts = HashMap::new();
    let now = now_ms();
    if let Ok(entries) = std::fs::read_dir(directory) { for entry in entries.flatten().take(256) {
        let path = entry.path();
        if path.extension().and_then(|s|s.to_str()) != Some("json") || !entry.metadata().is_ok_and(|m| m.is_file() && m.len() <= 8192) { continue; }
        let context = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<RuntimeContext>(&bytes).ok());
        let Some(context) = context else { continue };
        if context.version != 1 || !valid_agent_name(&context.persona) || path.file_stem().and_then(|s|s.to_str()) != Some(&context.persona)
            || context.pid == 0 || context.pid > i32::MAX as u32 || unsafe { libc::kill(context.pid as i32, 0) } != 0
            || now.saturating_sub(context.updated_at) > 15_000 || context.updated_at > now + 5_000 { continue; }
        if let Some(turn) = &context.turn {
            if turn.id.len() != 64 || !turn.id.bytes().all(|b|b.is_ascii_hexdigit()) || !matches!(turn.state.as_str(), "running"|"done")
                || turn.order.len() > 32 || turn.order.iter().any(|name| !valid_agent_name(name)) { continue; }
        }
        contexts.insert(context.persona.clone(), context);
    } }
    contexts
}
fn refresh_queue(surface: &Surface) -> Result<HashMap<String, RuntimeContext>, String> {
    let host = surface.app.state::<Host>();
    let contexts = runtime_contexts(&host);
    let before = surface.snapshot();
    let changed = {
        let mut s = surface.state.lock().unwrap();
        if s.mode == "stopped" { return Ok(contexts); }
        if contexts.values().any(attached) { s.queued = true; }
        s.grants.retain(|name, _| contexts.get(name).is_some_and(attached));
        for (name, _) in contexts.iter().filter(|(_, context)| attached(context)) {
            if !s.grants.contains_key(name) { s.grants.insert(name.clone(), Grant::new(name)?); }
        }
        s.queue.refresh(now_ms(), |name, request| match contexts.get(name) {
            None if local_persona(&host, name) => TurnState::Other,
            None => TurnState::Missing,
            Some(context) if !attached(context) => TurnState::Done,
            Some(context) => match &context.turn {
                Some(turn) if turn.id == request => if turn.state == "running" { TurnState::Running } else { TurnState::Done },
                _ => TurnState::Other,
            },
        });
        s.queued && s.advance()
    };
    if changed { surface.hide_cursor(); }
    if before != surface.snapshot() { surface.changed.send_replace(()); }
    publish_catalogs(&surface.app)?;
    Ok(contexts)
}
fn url(text: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = text.parse().map_err(|_| "invalid URL")?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() { return Err("Enter an HTTP(S) URL without credentials".into()); }
    Ok(url)
}
fn panes(bounds: &PanelBounds, window: &tauri::Window) -> Result<(tauri::Rect, tauri::Rect), String> {
    let rect = bounds.rect(window)?;
    let position = rect.position.to_logical::<f64>(1.);
    let size = rect.size.to_logical::<f64>(1.);
    if size.height < 80. || size.width < 240. { return Err("browser area is too small".into()); }
    let owner = tauri::Rect { position: position.into(), size: tauri::LogicalSize::new(size.width, 38.).into() };
    let browser = tauri::Rect { position: tauri::LogicalPosition::new(position.x, position.y + 38.).into(), size: tauri::LogicalSize::new(size.width, size.height - 38.).into() };
    Ok((owner, browser))
}
fn close(app: &tauri::AppHandle, id: Option<&str>) -> Result<(), String> {
    let host = app.state::<Host>();
    let selected = surfaces(app).into_iter().filter(|s| id.is_none_or(|id| s.id == id)).collect::<Vec<_>>();
    for surface in selected {
        host.surfaces.lock().unwrap().remove(&surface.id);
        surface.revoke("stopped");
        surface.replies.lock().unwrap().clear();
        let session_path = host.profile.join("session.json");
        if std::fs::read(&session_path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| v["id"] == surface.id) {
            let _ = std::fs::remove_file(session_path);
        }
        let _ = app.emit_to("main", "native-surface", surface.snapshot());
        let cursor_id = surface.id.clone();
        let _ = app.run_on_main_thread(move || remove_monitor(&cursor_id));
        for label in [surface.browser_label(), surface.owner_label()] { if let Some(view) = app.get_webview(&label) { view.close().map_err(|e| e.to_string())?; } }
    }
    publish_catalogs(app)
}

#[tauri::command]
fn native_surface_available() -> bool { true }

#[tauri::command]
async fn native_surface_open(app: tauri::AppHandle, webview: tauri::Webview, bounds: PanelBounds, palette: Option<cursor::Palette>, initial_url: Option<String>) -> Result<Value, String> {
    let host = app.state::<Host>();
    let _operation = host.lifecycle.lock().await;
    // Create at the requested address so CEF's initial load cannot replace it.
    let initial_url = url(initial_url.as_deref().unwrap_or("https://example.com/"))?;
    let (owner_rect, browser_rect) = panes(&bounds, &webview.window())?;
    let (changed, mut updates) = watch::channel(());
    let surface = Arc::new(Surface { id: random_hex()?, label: format!("Browser {}",host.next_label.fetch_add(1,std::sync::atomic::Ordering::Relaxed)), token: random_hex()?, app: app.clone(), input:tokio::sync::Mutex::new(()), replies: Mutex::default(), changed,
        state: Mutex::new(Control { mode: "human", epoch: 0, visible: true, viewport: None, url: initial_url.to_string(), title: String::new(), back: false, forward: false,
            grants: HashMap::new(), queue: Queue::default(), queued: !host.lab, driver: None }) });
    {
        let host = app.state::<Host>();
        let mut existing = host.surfaces.lock().unwrap();
        if existing.len() >= 4 { return Err("Close a browser before opening another (four maximum)".into()); }
        existing.insert(surface.id.clone(), surface.clone());
    }
    let result = async {
        let watched = Arc::downgrade(&surface);
        let child = webview.window().add_child(
            tauri::webview::WebviewBuilder::new(surface.browser_label(), WebviewUrl::External(initial_url))
                .browser_runtime_style(RuntimeStyle::Alloy).incognito(true).disable_drag_drop_handler()
                .on_navigation(|url| matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none())
                .on_new_window(|_, _| NewWindowResponse::Deny).on_download(|_, _| false)
                .on_permission_request(|_, _| PermissionResponse::Deny)
                .on_frame_event(move |event| {
                    if event.is_main { if let FrameEventKind::AddressChanged { url } | FrameEventKind::DocumentCommitted { url } = event.kind { if let Some(surface) = watched.upgrade() {
                        let mut s = surface.state.lock().unwrap(); s.url = url.to_string(); s.epoch += 1; s.viewport = None; surface.changed.send_replace(());
                    } } }
                }), browser_rect.position, browser_rect.size).map_err(|e| e.to_string())?;
        let watched = Arc::downgrade(&surface);
        child.on_dev_tools_protocol(move |event| {
            if let DevToolsProtocol::MethodResult { message_id, success, result } = event {
                if let Some(surface) = watched.upgrade() { if let Some(reply) = surface.replies.lock().unwrap().remove(&message_id) {
                    let value = if result.len() > 8 * 1024 * 1024 { Err("browser response exceeds 8 MiB".into()) }
                        else if success { serde_json::from_slice(&result).map_err(|e| e.to_string()) }
                        else { Err(String::from_utf8_lossy(&result).into_owned()) };
                    let _ = reply.send(value);
                } }
            }
        }).map_err(|e| e.to_string())?;
        install_monitor(&child, surface.clone(), palette.unwrap_or_default()).await?;
        webview.window().add_child(tauri::webview::WebviewBuilder::new(surface.owner_label(), WebviewUrl::App("owner.html".into()))
            .browser_runtime_style(RuntimeStyle::Alloy).incognito(true).disable_drag_drop_handler()
            .on_navigation(|url| url.as_str() == OWNER_URL).on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false).on_permission_request(|_, _| PermissionResponse::Deny), owner_rect.position, owner_rect.size).map_err(|e| e.to_string())?;
        let host = app.state::<Host>();
        if host.lab && !host.profile.join("session.json").exists() {
        let descriptor = json!({"version":1,"id":surface.id,"kind":"browser","label":"Fez Browser Lab", "endpoint":format!("unix://{}", host.profile.join("control.sock").display()),"agentToken":surface.token});
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(host.profile.join("session.json")).map_err(|e| e.to_string())?;
        file.write_all(descriptor.to_string().as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    }.await;
    if let Err(error) = result { let _ = close(&app, Some(&surface.id)); return Err(error); }
    refresh_queue(&surface)?;
    let watched = Arc::downgrade(&surface);
    tauri::async_runtime::spawn(async move { loop {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let Some(surface) = watched.upgrade() else { break };
        if surface.state.lock().unwrap().mode == "stopped" { break; }
        if let Err(error) = refresh_queue(&surface) { eprintln!("Browser queue: {error}"); surface.revoke("human"); }
    } });
    let watched = Arc::downgrade(&surface);
    tauri::async_runtime::spawn(async move {
        while updates.changed().await.is_ok() {
            updates.borrow_and_update();
            let Some(surface) = watched.upgrade() else { break };
            let state = surface.snapshot();
            let _ = surface.app.emit_to("main", "native-surface", &state);
            let _ = surface.app.emit_to(surface.owner_label(), "native-surface", state);
            // Never block CEF's callbacks with Tauri event delivery or another RPC.
            if let Ok(history) = surface.rpc("Page.getNavigationHistory", json!({}), None).await {
                if let (Some(index), Some(entries)) = (history["currentIndex"].as_u64(), history["entries"].as_array()) {
                    let mut s = surface.state.lock().unwrap(); s.back = index > 0; s.forward = (index as usize + 1) < entries.len();
                    s.title = entries.get(index as usize).and_then(|e| e["title"].as_str()).unwrap_or("").into();
                }
            }
            let state = surface.snapshot();
            let _ = surface.app.emit_to("main", "native-surface", &state);
            let _ = surface.app.emit_to(surface.owner_label(), "native-surface", state);
        }
    });
    surface.changed.send_replace(());
    Ok(surface.snapshot())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Action { Navigate { url: String }, History { delta: i8 }, Reload, Bounds { bounds: PanelBounds, visible: bool }, Palette { palette: cursor::Palette }, Close, Snapshot }
#[tauri::command]
async fn native_surface_action(app: tauri::AppHandle, webview: tauri::Webview, id: String, action: Action) -> Result<Value, String> {
    let host = app.state::<Host>();
    let _operation = host.lifecycle.lock().await;
    let surface = current(&app, Some(&id))?;
    match action {
        Action::Close => close(&app, Some(&id))?,
        Action::Palette { palette } => { app.run_on_main_thread(move || cursor::set_palette(&id,palette)).map_err(|e| e.to_string())?; }
        Action::Bounds { bounds, visible } => {
            if visible { surface.owner_navigation(); } else { surface.revoke("human"); }
            let rects = visible.then(|| panes(&bounds, &webview.window())).transpose()?;
            surface.state.lock().unwrap().visible = visible;
            if let Some((owner, browser)) = rects {
                surface.browser()?.set_bounds(browser).map_err(|e| e.to_string())?;
                app.get_webview(&surface.owner_label()).ok_or("owner control is closed")?.set_bounds(owner).map_err(|e| e.to_string())?;
            }
            for label in [surface.browser_label(), surface.owner_label()] { if let Some(view) = app.get_webview(&label) { if visible { view.show() } else { view.hide() }.map_err(|e| e.to_string())?; } }
        }
        Action::Snapshot => {
            let (send, recv) = oneshot::channel();
            surface.browser()?.with_cef_webview(move |view| { let s = view.snapshot(); let _ = send.send(json!({"parentMatches":s.parent_matches,"visible":s.visible,"bounds":s.bounds,"pointer":cursor::snapshot(&id)})); }).map_err(|e| e.to_string())?;
            return tokio::time::timeout(TIMEOUT, recv).await.map_err(|_| "snapshot timed out")?.map_err(|_| "browser closed".into());
        }
        _ => {
            if surface.state.lock().unwrap().mode != "human" { return Err("Take control before navigating".into()); }
            surface.owner_navigation();
            match action {
                Action::Navigate { url: text } => { surface.rpc("Page.navigate", json!({"url":url(&text)?.as_str()}), None).await?; }
                Action::Reload => { surface.rpc("Page.reload", json!({}), None).await?; }
                Action::History { delta } => {
                    if ![-1,1].contains(&delta) { return Err("invalid history direction".into()); }
                    let history = surface.rpc("Page.getNavigationHistory", json!({}), None).await?;
                    let index = history["currentIndex"].as_i64().ok_or("invalid browser history")? + i64::from(delta);
                    if index >= 0 { if let Some(entry) = history["entries"].get(index as usize) { surface.rpc("Page.navigateToHistoryEntry", json!({"entryId":entry["id"]}), None).await?; } }
                }
                _ => unreachable!(),
            }
        }
    }
    Ok(Value::Null)
}

// This command bypasses the main-only guard ONLY for the fixed host-owned view.
// Extension JavaScript and local/remote browser documents cannot grant control.
#[tauri::command]
async fn native_surface_owner(app: tauri::AppHandle, webview: tauri::Webview, action: String, request: Option<String>, persona: Option<String>) -> Result<Value, String> {
    let id = webview.label().strip_prefix("surface-owner-").ok_or("owner control required")?;
    let surface = current(&app, Some(id)).map_err(|_| "owner control required")?;
    if webview.label() != surface.owner_label() { return Err("owner control required".into()); }
    refresh_queue(&surface)?;
    match action.as_str() {
        "state" => (),
        "grant" | "resume" => {
            let host = app.state::<Host>();
            let _operation = host.lifecycle.try_lock().map_err(|_| "Browser is changing; try again")?;
            let mut s = surface.state.lock().unwrap();
            if !s.visible || s.mode == "stopped" { return Err("browser is not visible".into()); }
            s.queue.paused = false;
            if s.queued { s.advance(); } else { s.revoke("agent"); }
        }
        "cancel" => {
            let mut state = surface.state.lock().unwrap();
            state.queue.cancel(request.as_deref().ok_or("Missing waiting request")?, persona.as_deref().ok_or("Missing waiting persona")?)?;
            if state.advance() { surface.hide_cursor(); }
        }
        "take" => surface.revoke("human"),
        "stop" => { surface.revoke("stopped"); let host = app.state::<Host>(); let _operation = host.lifecycle.lock().await; close(&app, Some(&surface.id))?; },
        _ => return Err("unknown owner action".into()),
    }
    if action == "grant" || action == "resume" { surface.hide_cursor(); }
    surface.changed.send_replace(());
    Ok(surface.snapshot())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { id: Option<String>, token: String, action: Input }
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Input { Observe, Click { epoch: u64, x: f64, y: f64 }, Type { epoch: u64, text: String }, Key { epoch: u64, key: String }, Wheel { epoch: u64, x: f64, y: f64, #[serde(rename="deltaX")] dx: f64, #[serde(rename="deltaY")] dy: f64 } }
async fn agent(surface: Arc<Surface>, action: Input, authorized_epoch: u64) -> Result<Value, String> {
    let _input = surface.input.lock().await;
    let epoch = match &action { Input::Observe => authorized_epoch,
        Input::Click { epoch, .. } | Input::Type { epoch, .. } | Input::Key { epoch, .. } | Input::Wheel { epoch, .. } => *epoch };
    if epoch != authorized_epoch { return Err("Control changed; observe again".into()); }
    surface.check(epoch)?;
    if matches!(action, Input::Observe) {
        let metrics = surface.rpc("Page.getLayoutMetrics", json!({}), Some(epoch)).await?;
        let viewport = &metrics["cssLayoutViewport"];
        let width = viewport["clientWidth"].as_f64().ok_or("invalid viewport")?;
        let height = viewport["clientHeight"].as_f64().ok_or("invalid viewport")?;
        if !(1. ..=16384.).contains(&width) || !(1. ..=16384.).contains(&height) { return Err("invalid viewport dimensions".into()); }
        let dpr = surface.rpc("Runtime.evaluate", json!({"expression":"devicePixelRatio","returnByValue":true}), Some(epoch)).await?;
        let dpr = dpr["result"]["value"].as_f64().filter(|d| *d > 0. && d.is_finite()).ok_or("invalid pixel ratio")?;
        let shot = surface.rpc("Page.captureScreenshot", json!({"format":"jpeg","quality":65,"captureBeyondViewport":false,"clip":{"x":viewport["pageX"],"y":viewport["pageY"],"width":width,"height":height,"scale":(1024. / width.max(height)).min(1.) / dpr}}), Some(epoch)).await?;
        { let mut s = surface.state.lock().unwrap(); s.check(epoch)?; s.viewport = Some((width,height)); }
        return Ok(json!({"mode":"agent","epoch":epoch,"data":shot["data"],"viewport":{"clientWidth":width as u64,"clientHeight":height as u64}}));
    }
    let (width, height) = surface.state.lock().unwrap().viewport.ok_or("observe before input")?;
    let point = |x: f64,y: f64| -> Result<(), String> { if x.is_finite() && y.is_finite() && x >= 0. && y >= 0. && x < width && y < height { Ok(()) } else { Err("input is outside the observed browser".into()) } };
    match action {
        Input::Click { x, y, .. } => {
            point(x,y)?;
            surface.move_cursor(epoch,x,y,(width,height)).await?;
            for kind in ["mousePressed","mouseReleased"] { surface.rpc("Input.dispatchMouseEvent", json!({"type":kind,"x":x,"y":y,"button":"left","clickCount":1}), Some(epoch)).await?; }
        }
        Input::Type { text, .. } => {
            if text.len() > 16384 || text.chars().count() > 4096 { return Err("text is too long".into()); }
            surface.rpc("Input.insertText", json!({"text":text}), Some(epoch)).await?;
        }
        Input::Key { key, .. } => {
            let code = match key.as_str() { "Enter"=>13,"Tab"=>9,"Backspace"=>8,"Escape"=>27,"ArrowLeft"=>37,"ArrowUp"=>38,"ArrowRight"=>39,"ArrowDown"=>40,_=>return Err("unsupported key".into()) };
            for kind in ["keyDown","keyUp"] { let mut params = json!({"type":kind,"key":key,"windowsVirtualKeyCode":code}); if key=="Enter" && kind=="keyDown" {params["text"]=json!("\r");} surface.rpc("Input.dispatchKeyEvent", params, Some(epoch)).await?; }
        }
        Input::Wheel { x,y,dx,dy,.. } => {
            point(x,y)?;
            if !dx.is_finite() || !dy.is_finite() || dx.abs()>4096. || dy.abs()>4096. { return Err("invalid scroll amount".into()); }
            surface.rpc("Input.dispatchMouseEvent", json!({"type":"mouseWheel","x":x,"y":y,"deltaX":dx,"deltaY":dy}), Some(epoch)).await?;
        }
        Input::Observe => unreachable!(),
    }
    surface.check(epoch)?;
    Ok(json!({"mode":"agent","epoch":epoch}))
}
fn serve(app: tauri::AppHandle, listener: UnixListener) {
    // Bounded workers let separate browser input run concurrently. A per-surface
    // lock below admission prevents overlapping actions inside one browser.
    let (send, receive) = std::sync::mpsc::sync_channel::<std::os::unix::net::UnixStream>(16);
    let receive = Arc::new(Mutex::new(receive));
    for _ in 0..8 {
        let receive = receive.clone(); let app = app.clone();
        std::thread::spawn(move || loop {
            let next = receive.lock().unwrap().recv();
            let Ok(mut stream) = next else { break };
            let _ = stream.set_read_timeout(Some(TIMEOUT)); let _ = stream.set_write_timeout(Some(TIMEOUT));
            let response = (|| -> Result<Value, String> {
                let mut line = Vec::new(); BufReader::new((&stream).take(16385)).read_until(b'\n', &mut line).map_err(|e| e.to_string())?;
                if line.len()>16384 || line.last()!=Some(&b'\n') { return Err("invalid native request size".into()); }
                let request: Request = serde_json::from_slice(&line).map_err(|_| "invalid native request")?;
                let surface = current(&app,request.id.as_deref())?;
                let contexts = refresh_queue(&surface)?;
                let host = app.state::<Host>();
                let persona = {
                    let state = surface.state.lock().unwrap();
                    let matches = |token: &str| request.token.len() == token.len() && request.token.bytes().zip(token.bytes()).fold(0u8,|diff,(a,b)|diff|(a^b)) == 0;
                    if host.lab && !state.queued && matches(&surface.token) { None }
                    else { Some(state.grants.values().find(|grant| matches(&grant.token)).map(|grant| grant.persona.clone()).ok_or("Browser Use is not attached to this running agent")?) }
                };
                if let Some(persona) = &persona {
                    let turn = contexts.get(persona).and_then(|c|c.turn.as_ref()).filter(|t|t.state == "running").ok_or("No active Fez turn; ask the agent in Fez")?;
                    if matches!(request.action, Input::Observe) {
                        // Admission is atomic across browsers: reserve order locally,
                        // but remove peers who chose a different browser this turn.
                        let mut routes = host.routes.lock().unwrap();
                        routes.retain(|(request,name),_| contexts.get(name).and_then(|c|c.turn.as_ref()).is_some_and(|t| t.id == *request && t.state == "running"));
                        let key = (turn.id.clone(),persona.clone());
                        if routes.get(&key).is_some_and(|id| id != &surface.id) { return Err("This Fez turn is already using another browser; finish this turn before changing targets".into()); }
                        let mut order: Vec<String> = turn.order.iter().filter(|name| {
                            routes.get(&(turn.id.clone(),(*name).clone())).is_none_or(|id| id == &surface.id)
                                && contexts.get(*name).map_or_else(|| local_persona(&host,name), attached)
                        }).cloned().collect();
                        if !order.contains(persona) { order.push(persona.clone()); }
                        // Failed admission must preserve the turn's right to
                        // choose another browser and its sibling reservations.
                        surface.state.lock().unwrap().queue.request(&turn.id,&order,persona,now_ms())?;
                        routes.insert(key,surface.id.clone());
                        for other in surfaces(&app).into_iter().filter(|other| other.id != surface.id) {
                            let mut state = other.state.lock().unwrap();
                            if state.queue.cancel(&turn.id,persona).is_ok() {
                                if state.advance() { other.hide_cursor(); }
                                other.changed.send_replace(());
                            }
                        }
                        let mut state = surface.state.lock().unwrap();
                        if state.advance() { surface.hide_cursor(); }
                        surface.changed.send_replace(());
                        if state.driver.as_deref() != Some(persona) {
                            return Ok(json!({"mode":"waiting","paused":state.queue.paused,"driver":state.driver,"waiting":state.queue.waiting()}));
                        }
                    }
                }
                let authorized_epoch = {
                    let state = surface.state.lock().unwrap();
                    if persona.as_ref().is_some_and(|persona| state.driver.as_deref() != Some(persona)) { return Err("Another driver or the owner has control; observe before continuing".into()); }
                    state.epoch
                };
                tauri::async_runtime::block_on(agent(surface,request.action,authorized_epoch))
            })();
            let response = response.unwrap_or_else(|error| json!({"error":error})).to_string();
            let _ = writeln!(stream,"{response}");
        });
    }
    std::thread::spawn(move || { for stream in listener.incoming() {
        let Ok(stream) = stream else { break };
        if let Err(std::sync::mpsc::TrySendError::Full(mut stream)) = send.try_send(stream) {
            let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
            let _ = writeln!(stream,"{{\"error\":\"Browser is busy; try again\"}}");
        }
    } });
}

type NativeObserver = objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>;
struct Monitor { event: objc2::rc::Retained<objc2::runtime::AnyObject>, notifications: Vec<NativeObserver> }
thread_local! { static MONITORS: std::cell::RefCell<HashMap<String,Monitor>> = std::cell::RefCell::new(HashMap::new()); }
fn remove_monitor(id: &str) {
    cursor::remove(id);
    MONITORS.with(|monitors| { if let Some(monitor) = monitors.borrow_mut().remove(id) {
        unsafe { objc2_app_kit::NSEvent::removeMonitor(&monitor.event); }
        for observer in monitor.notifications { unsafe { objc2_foundation::NSNotificationCenter::defaultCenter().removeObserver(AsRef::<objc2::runtime::AnyObject>::as_ref(&*observer)); } }
    } });
}
fn remove_monitors() {
    let ids = MONITORS.with(|monitors| monitors.borrow().keys().cloned().collect::<Vec<_>>());
    for id in ids { remove_monitor(&id); }
}
async fn install_monitor(child: &tauri::Webview, surface: Arc<Surface>, palette: cursor::Palette) -> Result<(), String> {
    let (send, recv) = oneshot::channel();
    child.with_cef_webview(move |view| {
        use objc2::rc::Retained;
        use objc2_app_kit::{NSEvent,NSEventMask,NSEventType,NSView};
        let result = (|| -> Result<(), String> {
            remove_monitor(&surface.id);
            let host = view.browser().host().ok_or("browser host missing")?;
            let native = unsafe { Retained::<NSView>::retain(host.window_handle().cast()) }.ok_or("native browser view missing")?;
            cursor::install(&surface.id, &native, palette);
            let window = native.window().ok_or("browser window missing")?;
            let hidden = surface.clone();
            let invalidate = block2::RcBlock::new(move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| hidden.revoke("human"));
            let center = objc2_foundation::NSNotificationCenter::defaultCenter();
            // AppKit notifications invalidate even if no agent request arrives
            // during the hidden interval. Restoring never restores a grant.
            let observers = unsafe { vec![
                center.addObserverForName_object_queue_usingBlock(Some(objc2_app_kit::NSWindowDidMiniaturizeNotification), Some(&window), None, &invalidate),
                center.addObserverForName_object_queue_usingBlock(Some(objc2_app_kit::NSApplicationDidHideNotification), None, None, &invalidate),
            ] };
            // CEF completes browser close when its NSView deallocates. The
            // monitor must not keep that view alive while waiting for app Exit.
            let native = objc2::rc::Weak::from_retained(&native);
            let monitor_id = surface.id.clone();
            let handler = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
                let e = unsafe { event.as_ref() };
                let inside = (|| {
                    let Some(native) = native.load() else { return false; };
                    if native.isHiddenOrHasHiddenAncestor() { return false; }
                    let Some(window)=native.window() else {return false};
                    if e.window(objc2::MainThreadMarker::new().expect("CEF input runs on the main thread")).as_deref()!=Some(&*window) {return false;}
                    if matches!(e.r#type(), NSEventType::KeyDown|NSEventType::KeyUp|NSEventType::FlagsChanged) {
                        window.firstResponder().as_ref().and_then(|r| r.downcast_ref::<NSView>()).is_some_and(|r| r.isDescendantOf(&native))
                    } else {
                        let p=native.convertPoint_fromView(e.locationInWindow(),None); let b=native.bounds();
                        p.x>=b.origin.x && p.y>=b.origin.y && p.x<b.origin.x+b.size.width && p.y<b.origin.y+b.size.height
                    }
                })();
                if inside { let mut state=surface.state.lock().unwrap(); if state.mode=="agent" || !state.queue.is_empty() {state.revoke("human");cursor::hide(&surface.id);surface.changed.send_replace(());} }
                event.as_ptr()
            });
            let mask=NSEventMask::LeftMouseDown|NSEventMask::RightMouseDown|NSEventMask::OtherMouseDown|NSEventMask::KeyDown|NSEventMask::KeyUp|NSEventMask::FlagsChanged|NSEventMask::ScrollWheel|NSEventMask::LeftMouseDragged|NSEventMask::RightMouseDragged;
            let monitor=unsafe {NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask,&handler)}.ok_or("native input monitor unavailable")?;
            MONITORS.with(|slot| slot.borrow_mut().insert(monitor_id, Monitor { event:monitor, notifications:observers }));
            Ok(())
        })();
        let _=send.send(result);
    }).map_err(|e| e.to_string())?;
    tokio::time::timeout(TIMEOUT,recv).await.map_err(|_|"input monitor timed out")?.map_err(|_|"browser closed")?
}

/// Configure the same host for the real desktop or a disposable, identity-free lab.
pub(crate) fn configure(builder: tauri::Builder, lab_profile: Option<PathBuf>) -> Result<tauri::Builder, String> {
    let lab = lab_profile.is_some();
    let profile = if let Some(profile) = lab_profile { profile } else {
        super::desktop_runtime::claim()?;
        super::fez_home()?.join("native-surfaces")
    };
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&profile,std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    // The desktop ownership lock excludes another full host; lab profiles are new.
    if !lab {
        let _ = std::fs::remove_file(profile.join("control.sock"));
        for entry in std::fs::read_dir(&profile).map_err(|e| e.to_string())?.flatten() {
            if entry.file_name().to_str().and_then(|s| s.strip_suffix(".json")).is_some_and(valid_agent_name) {
                std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
    }
    let listener = UnixListener::bind(profile.join("control.sock")).map_err(|e| e.to_string())?;
    std::fs::set_permissions(profile.join("control.sock"),std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    // System storage must not read the mock-encrypted experimental profile.
    let cache = if lab { profile.join("chromium") } else { super::fez_home()?.join("browser-v1/chromium") };
    let mut cef = Cef::default().sandbox(SandboxPolicy::Required).secret_storage(if lab { SecretStorage::Mock } else { SecretStorage::System }).root_cache_path(cache).log_file(profile.join("cef.log"));
    // Only debug builds may expose the test driver. Normal development use has no port.
    if lab && cfg!(debug_assertions) { if let Ok(port) = std::env::var("FEZ_UPSTREAM_DEBUG_PORT") { cef = cef.remote_debugging(tauri_runtime_cef::RemoteDebugging::Port { port: port.parse().map_err(|_| "invalid test port")?, allowed_origins: vec![] }); } }
    let plugin = tauri::plugin::Builder::<_, ()>::new("native-surfaces")
        .setup(move |app, _| {
            serve(app.clone(), listener);
            Ok(())
        })
        .on_page_load(|view,event| { if view.label()=="main" && matches!(event.event(),tauri::webview::PageLoadEvent::Started) {
            let app=view.app_handle().clone();
            let old = surfaces(&app);
            for surface in &old { surface.revoke("stopped"); }
            tauri::async_runtime::spawn(async move {let host=app.state::<Host>(); let _operation=host.lifecycle.lock().await; for surface in old {let _=close(&app,Some(&surface.id));} });
        } })
        .on_event(|app,event| {
            match event {
                tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => {
                    for surface in surfaces(app) { match event {
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged {..} => surface.revoke("human"),
                        tauri::WindowEvent::CloseRequested {..} if !app.state::<Host>().lab => surface.revoke("human"),
                        tauri::WindowEvent::CloseRequested {..} | tauri::WindowEvent::Destroyed => {
                            surface.revoke("stopped");
                            let _=std::fs::remove_file(app.state::<Host>().profile.join("session.json"));
                        }
                        _=>(),
                    } }
                }
                tauri::RunEvent::Exit => {
                    let host = app.state::<Host>();
                    for surface in surfaces(app) { surface.revoke("stopped"); }
                    host.surfaces.lock().unwrap().clear();
                    let _ = publish_catalogs(app);
                    let _ = std::fs::remove_file(host.profile.join("session.json"));
                    let _ = std::fs::remove_file(host.profile.join("control.sock"));
                    remove_monitors();
                }
                _ => (),
            }
        }).build();
    Ok(builder.runtime(cef).manage(Host {surfaces:Mutex::default(),published:Mutex::default(),routes:Mutex::default(),next_label:std::sync::atomic::AtomicUsize::new(1),lifecycle:tokio::sync::Mutex::new(()),profile,lab}).plugin(plugin))
}

// Window creation needs Tauri's plugin store, which remains locked during plugin
// setup. Call from the app setup after plugin initialization has finished.
pub(crate) fn open_main(app: &tauri::App) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app,"main",WebviewUrl::default()).title("Fez · Native Browser").inner_size(1440.,900.)
        .browser_runtime_style(RuntimeStyle::Alloy).disable_drag_drop_handler()
        .on_navigation(|url| url.as_str()=="http://tauri.localhost/" || url.as_str()=="http://tauri.localhost/index.html")
        .on_new_window(|_,_|NewWindowResponse::Deny).build()?;
    Ok(())
}

pub(crate) fn handler<F>(next: F) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static
where F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    let commands = isolated_panel::guard(tauri::generate_handler![native_surface_available,native_surface_open,native_surface_action]);
    let owner: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![native_surface_owner];
    move |invoke| {
        if invoke.message.command()=="native_surface_owner" { owner(invoke) }
        else if matches!(invoke.message.command(), "native_surface_available" | "native_surface_open" | "native_surface_action") { commands(invoke) }
        else { next(invoke) }
    }
}

pub fn run_lab() {
    assert!(cfg!(debug_assertions), "Browser Lab is a development build only");
    let profile = PathBuf::from(std::env::var_os("FEZ_UPSTREAM_PROFILE").expect("Provide a new disposable FEZ_UPSTREAM_PROFILE directory")).canonicalize().expect("profile exists");
    assert!(profile.starts_with("/private/tmp") && std::fs::read_dir(&profile).unwrap().next().is_none(), "use an empty profile under /private/tmp");
    configure(tauri::Builder::default(),Some(profile)).expect("configure native browser")
        .plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_notification::init()).plugin(tauri_plugin_updater::Builder::new().build())
        .channel_interceptor(isolated_panel::channel_message)
        .invoke_handler(handler(|_| false))
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app,"main",WebviewUrl::default()).title("Fez Browser Lab").inner_size(1120.,800.)
                .browser_runtime_style(RuntimeStyle::Alloy)
                .on_navigation(|url| url.as_str()=="http://tauri.localhost/" || url.as_str()=="http://tauri.localhost/index.html")
                .on_new_window(|_,_|NewWindowResponse::Deny).build()?;
            Ok(())
        }).build(super::app_context()).expect("start Fez browser workbench").run(|_,_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_use_accepts_current_and_legacy_attachments_only() {
        let mut context = RuntimeContext { version: 1, persona: "quill".into(), pid: 1,
            tools: Vec::new(), updated_at: 0, turn: None };
        for (tool, expected) in [("browser-use", true), ("computer-use", true), ("browser", false), ("web", false)] {
            context.tools = vec![tool.into()];
            assert_eq!(attached(&context), expected, "{tool}");
        }
    }

    #[test]
    fn expired_input_cannot_dispatch_and_old_timeouts_do_not_revoke_new_control() {
        let mut state = Control { mode: "agent", epoch: 7, visible: true, viewport: Some((800., 600.)),
            url: String::new(), title: String::new(), back: false, forward: false,
            grants: HashMap::new(), queue: Queue::default(), queued: true, driver: Some("quill".into()) };
        assert!(state.check(7).is_ok());
        assert!(state.expire(7));
        assert!(state.check(7).is_err());
        assert!(state.viewport.is_none());
        assert!(state.queue.paused);
        state.mode = "agent";
        state.driver = Some("drift".into());
        state.queue.paused = false;
        assert!(!state.expire(7));
        assert!(state.check(8).is_ok());
        assert_eq!(state.driver.as_deref(), Some("drift"));
    }
}
