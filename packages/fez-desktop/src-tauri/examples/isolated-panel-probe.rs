//! Manual macOS/WKWebView check. Run with `--features tauri/custom-protocol`
//! for bundled assets, or against `vite preview --port 4318` without it.
//! Installs the shipped voice panel under a different name to prove generic routing.
//! Uses temporary extension state and private browser stores; no keychain or agents.
#[allow(dead_code)]
#[path = "../src/package_install.rs"]
mod package_install;
#[path = "../src/isolated_panel.rs"]
mod isolated_panel;
use serde_json::{json, Value};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::Manager;

#[tauri::command]
fn probe_channel(channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> Result<(), String> {
    channel.send(tauri::ipc::InvokeResponseBody::Json(json!({"text":"channel canary".repeat(1000), "__proto__":{"canary":true}}).to_string())).map_err(|e| e.to_string())?;
    channel.send(tauri::ipc::InvokeResponseBody::Raw(vec![42; 9001])).map_err(|e| e.to_string())
}

fn main() {
    let stun = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    stun.set_nonblocking(true).unwrap();
    let stun_port = stun.local_addr().unwrap().port();
    let home = tempfile::tempdir().unwrap();
    let package = home.path().join("packages/voice-settings-probe");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"fez":{"parts":{"gui":"gui.js"}}}"#).unwrap();
    let bundle = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fez-elevenlabs/dist/gui.js")).unwrap();
    std::fs::write(package.join("gui.js"), bundle + &r#"
const original = __fezExt.default;
__fezExt = {default: api => {
  original(api);
  void (async () => {
    const pause = () => new Promise(resolve => setTimeout(resolve, 50));
    for (let i = 0; i < 200 && !document.querySelector('select:not(:disabled)'); i++) await pause();
    const select = document.querySelector('select:not(:disabled)');
    if (!select) throw Error('voice panel did not mount');
    select.value = 'CwhRBWXzGAHq8TQ4Fs17';
    select.dispatchEvent(new Event('change', {bubbles:true}));
    for (let i = 0; i < 100 && !(await api.prefs.get('voices'))?.fez; i++) await pause();
    const result = { heading: document.querySelector('h1')?.textContent, voices: await api.prefs.get('voices'), mainStorage: localStorage.getItem('__fezIsolationProbe'), mainGlobal: typeof window.__fezIsolationProbe };
    for (const [key, command, args] of [
      ['native', 'get_identity', {}],
      ['plugin', 'plugin:event|emit', {event:'probe',payload:null}],
      ['spoof', 'isolated_panel_request', {request:{op:'set_preference', key:'x', value:1, name:'wallet'}}],
    ]) {
      try { await window.__TAURI_INTERNALS__.invoke(command,args); result[key] = 'ALLOWED'; }
      catch (error) { result[key] = String(error); }
    }
    await api.client.saveExtensionConfig('fez-voice-settings-probe', { marker:'scoped config', padding:'x'.repeat(9000) });
    const config = await api.client.extensionConfig('fez-voice-settings-probe');
    result.hostConfig = config.marker === 'scoped config' && config.padding.length === 9000;
    await api.secrets.set('token', 'fixture-token');
    result.hostSecret = await api.secrets.has('token');
    try { await api.client.extensionConfig('fez-github'); result.otherConfig = 'ALLOWED'; }
    catch (error) { result.otherConfig = String(error); }
    let fetchCsp = false;
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'connect-src' && event.blockedURI.startsWith('https://example.invalid')) fetchCsp = true;
    });
    try { await fetch('https://example.invalid/'); result.network = 'ALLOWED'; }
    catch { result.network = 'denied'; }
    await pause();
    result.fetchCsp = fetchCsp;
    result.rtcAvailable = typeof RTCPeerConnection !== 'undefined';
    if (result.rtcAvailable) {
      const rtc = new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:PROBE_STUN_PORT'}]});
      rtc.createDataChannel('probe');
      await rtc.setLocalDescription(await rtc.createOffer());
      await new Promise(resolve => setTimeout(resolve, 1500));
      rtc.close();
    }
    result.popup = window.open('https://example.invalid/') === null ? 'denied' : 'ALLOWED';
    await api.prefs.set('probe', result);
    location.href = '/index.html';
  })().catch(error => api.prefs.set('probe', {error:String(error)}));
}};
"#.replace("PROBE_STUN_PORT", &stun_port.to_string())).unwrap();
    std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"voice-settings-probe":["ui","read:channels","read:agents","sign","publish"]}}"#).unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some("http://127.0.0.1:4318".parse().unwrap());
    let path = home.path().join("extension-data/voice-settings-probe.json");
    let success = Arc::new(AtomicBool::new(false));
    let outcome = success.clone();
    let app = tauri::Builder::default()
        .channel_interceptor(isolated_panel::channel_message)
        .manage(isolated_panel::PanelHost::new(home.path().to_owned()))
        .invoke_handler(isolated_panel::guard(tauri::generate_handler![probe_channel, isolated_panel::open_isolated_panel, isolated_panel::isolated_panel_request, isolated_panel::isolated_panel_host_request, isolated_panel::isolated_panel_reply]))
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("isolated-panel.html".into()))
                .visible(false).incognito(true)
                .initialization_script(r#"
                    window.__fezIsolationProbe = 'main';
                    localStorage.setItem('__fezIsolationProbe','main');
                    document.addEventListener('DOMContentLoaded', async () => {
                        let config;
                        const secrets = new Map();
                        const ipc = window.__TAURI_INTERNALS__;
                        await new Promise((resolve, reject) => {
                            let received = 0;
                            const channel = ipc.transformCallback(({message,index,end}) => {
                                if (end) return;
                                const valid = index === 0
                                    ? message.text === 'channel canary'.repeat(1000) && Object.hasOwn(message,'__proto__')
                                    : index === 1 && message instanceof ArrayBuffer && message.byteLength === 9001 && new Uint8Array(message)[9000] === 42;
                                if (!valid) reject(Error('large channel delivery failed'));
                                else if (++received === 2) resolve();
                            });
                            void ipc.invoke('probe_channel', {channel:'__CHANNEL__:'+channel}).catch(reject);
                        });
                        const callback = ipc.transformCallback(async ({message:id,end}) => {
                            if (end) return;
                            let result;
                            try {
                                const op = await ipc.invoke('isolated_panel_host_request', {id});
                                if (op.scope !== 'fez-voice-settings-probe') throw Error('wrong scope');
                                let value = null;
                                if (op.op === 'get_config') value = {value:config};
                                else if (op.op === 'set_config') config = op.value;
                                else if (op.op === 'set_secret') secrets.set(op.key,op.value);
                                else if (op.op === 'has_secret') value = secrets.has(op.key);
                                else throw Error('unsupported host operation');
                                result = {Ok:value};
                            } catch (error) { result = {Err:String(error)}; }
                            await ipc.invoke('isolated_panel_reply', {id,result});
                        });
                        void ipc.invoke('open_isolated_panel', {name:'voice-settings-probe',agents:[['a'.repeat(64),'fez']],hostRequests:'__CHANNEL__:'+callback});
                    }, {once:true});
                "#)
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for attempt in 0..150 {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if attempt == 75 {
                        if let Some(panel) = handle.get_webview_window("extension-panel-1") {
                            let _ = panel.eval("window.__TAURI_INTERNALS__.invoke('isolated_panel_request',{request:{op:'set_preference',key:'diagnostic',value:document.body.innerText}})");
                        }
                    }
                    let probe = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                        .and_then(|value| value["prefs"].get("probe").cloned());
                    if let Some(probe) = probe {
                        // Let the attempted navigation reach the native decision handler.
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        let panel = handle.get_webview_window("extension-panel-1").unwrap();
                        let url = panel.url().unwrap();
                        let rtc_traffic = stun.recv(&mut [0; 2048]).is_ok();
                        let passed = probe["heading"] == "voice-settings-probe settings"
                            && probe["voices"] == json!({"fez":"CwhRBWXzGAHq8TQ4Fs17"})
                            && probe["hostConfig"] == true && probe["hostSecret"] == true
                            && probe["otherConfig"].as_str().is_some_and(|s| s.contains("another extension"))
                            && probe["mainStorage"].is_null() && probe["mainGlobal"] == "undefined"
                            && probe["native"].as_str().is_some_and(|s| s.contains("denied"))
                            && probe["plugin"].as_str().is_some_and(|s| s.contains("not allowed"))
                            && probe["spoof"].as_str().is_some_and(|s| s.contains("unknown field"))
                            && probe["network"] == "denied" && probe["fetchCsp"] == true && probe["popup"] == "denied"
                            && url.path() == "/isolated-panel.html";
                        println!("WKWebView probe: {}\n{}\nURL: {url}", if passed { "PASS" } else { "FAIL" }, serde_json::to_string_pretty(&probe).unwrap());
                        println!("WebRTC loopback traffic observed: {rtc_traffic} (network isolation is not guaranteed)");
                        outcome.store(passed, Ordering::Relaxed);
                        handle.exit(if passed { 0 } else { 1 });
                        return;
                    }
                }
                eprintln!("WKWebView probe timed out: {:?}", std::fs::read_to_string(&path));
                handle.exit(1);
            });
            Ok(())
        }).build(context).unwrap();
    app.run_return(|_, _| {});
    drop(home);
    std::process::exit(if success.load(Ordering::Relaxed) { 0 } else { 1 });
}
