//! Real macOS document view check, using the shipped Kanban bundle and temporary
//! fixture state only. Run with `cargo run --example isolated-page-probe --features tauri/custom-protocol`.
//! Add `-- --hold` for visible manual capture, and `--plain-window` for the
//! opaque/no-vibrancy comparison. Hold opens details only when you click a card.
//! PAINT/NATIVE JSON lines describe DOM and native layers before/during/after close.
#[allow(dead_code)]
#[path = "../src/package_install.rs"]
mod package_install;
#[path = "../src/isolated_panel.rs"]
mod isolated_panel;
use serde_json::{json, Value};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::Manager;


// This command exists only in this disposable executable. Production's guard is
// unchanged; the probe records child DOM state without adding app authority.
#[tauri::command]
fn probe_paint(webview: tauri::Webview, phase: String, metrics: Value) -> Result<(), String> {
    if phase.len() > 80 || metrics.to_string().len() > 65_536 { return Err("probe report too large".into()); }
    println!("PAINT {}", json!({"phase":phase,"webview":webview.label(),"dom":metrics}));
    #[cfg(target_os = "macos")]
    webview.with_webview(move |platform| unsafe {
        use objc2::{msg_send, runtime::{AnyObject, Bool}};
        unsafe fn describe(object: *mut AnyObject) -> String {
            if object.is_null() { return "nil".into(); }
            let description: *mut AnyObject = msg_send![object, description];
            let text: *const std::ffi::c_char = msg_send![description, UTF8String];
            if text.is_null() { return "nil".into(); }
            std::ffi::CStr::from_ptr(text).to_string_lossy().chars().take(600).collect()
        }
        unsafe fn tree(view: *mut AnyObject, depth: usize, remaining: &mut usize) -> Value {
            if view.is_null() || depth > 5 || *remaining == 0 { return Value::Null; }
            *remaining -= 1;
            let hidden: Bool = msg_send![view, isHidden];
            let opaque: Bool = msg_send![view, isOpaque];
            let alpha: f64 = msg_send![view, alphaValue];
            let layer: *mut AnyObject = msg_send![view, layer];
            let layer_state = if layer.is_null() { Value::Null } else {
                let hidden: Bool = msg_send![layer, isHidden];
                let opacity: f32 = msg_send![layer, opacity];
                let contents: *mut AnyObject = msg_send![layer, contents];
                json!({"description":describe(layer),"hidden":hidden.as_bool(),"opacity":opacity,"hasContents":!contents.is_null()})
            };
            let subviews: *mut AnyObject = msg_send![view, subviews];
            let count: usize = msg_send![subviews, count];
            let children: Vec<Value> = (0..count.min(40)).map(|i| {
                let child: *mut AnyObject = msg_send![subviews, objectAtIndex:i];
                tree(child, depth + 1, remaining)
            }).collect();
            json!({"description":describe(view),"hidden":hidden.as_bool(),"opaque":opaque.as_bool(),"alpha":alpha,"layer":layer_state,"children":children})
        }
        let window = platform.ns_window().cast::<AnyObject>();
        let visible: Bool = msg_send![window, isVisible];
        let key: Bool = msg_send![window, isKeyWindow];
        let opaque: Bool = msg_send![window, isOpaque];
        let occlusion: usize = msg_send![window, occlusionState];
        let content: *mut AnyObject = msg_send![window, contentView];
        let mut remaining = 120;
        println!("NATIVE {}", json!({"phase":phase,"visible":visible.as_bool(),"key":key.as_bool(),"opaque":opaque.as_bool(),"occlusion":occlusion,"tree":tree(content,0,&mut remaining)}));
    }).map_err(|error| error.to_string())?;
    Ok(())
}

const PAINT_SCRIPT: &str = r#"
window.probePaint = async phase => {
  const describe = element => {
    if (!element) return null;
    const style=getComputedStyle(element), rect=element.getBoundingClientRect();
    return {tag:element.tagName,class:element.className,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      display:style.display,visibility:style.visibility,opacity:style.opacity,background:style.backgroundColor,
      color:style.color,transform:style.transform,zIndex:style.zIndex,position:style.position};
  };
  await window.__TAURI_INTERNALS__.invoke('probe_paint',{phase,metrics:{readyState:document.readyState,hidden:document.hidden,
    viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},surface:document.documentElement.dataset.surface,
    html:describe(document.documentElement),body:describe(document.body),root:describe(document.getElementById('root')),
    dialog:describe(document.querySelector('dialog')),center:document.elementsFromPoint(innerWidth/2,innerHeight/2).map(describe),
    text:document.body.innerText.slice(0,2000)}});
};
"#;

fn main() {
    let hold = std::env::args().any(|arg| arg == "--hold");
    let plain = std::env::args().any(|arg| arg == "--plain-window");
    println!("Fez overlay probe pid={} hold={hold} plain={plain}", std::process::id());
    let home = tempfile::tempdir().unwrap();
    let package = home.path().join("packages/page-probe");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(package.join("package.json"), r#"{"fez":{"parts":{"gui":"gui.js"},"guiRuntime":"isolated-page","guiContributions":{"page":{"name":"▦ board"}}}}"#).unwrap();
    let bundle = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fez-kanban/dist/gui.js")).unwrap();
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fez-kanban/dist/gui.css"), package.join("gui.css")).unwrap();
    std::fs::write(package.join("gui.js"), bundle + &format!("\nconst probeHold={hold};\n") + r#"
const original = __fezExt.default;
__fezExt = {default: api => {
  let latest;
  const register = api.registerPageView;
  api.registerPageView = (name, match, render) => register(name, match, props => { latest = props; return render(props); });
  original(api);
  void (async () => {
    const waitFor = async test => { for (let i=0;i<(probeHold?6000:200);i++) { if(test()) return; await new Promise(resolve=>setTimeout(resolve,50)); } throw Error('fixture timed out'); };
    await waitFor(()=>document.querySelector('.board-card-open') && latest && window.probePaint);
    const start = latest;
    await window.probePaint('board-before-details');
    if(!probeHold) document.querySelector('.board-card-open').click();
    await waitFor(()=>window.probeDetails===true);
    const detail = window.probeDetails===true && !document.querySelector('dialog');
    await window.probePaint('board-after-details-close');
    const firstDocument = document;
    await latest.save(latest.content+'\n- [ ] Added in isolated page\n');
    await waitFor(()=>latest.versionId==='v2' && document.body.textContent.includes('Added in isolated page'));
    let stale;
    try { await start.save('overwrite'); stale='ALLOWED'; } catch(error) { stale=String(error); }
    await latest.comment('@fez fixture assignment', '- [ ] Fixture card @fez', ['fez']);
    const result = { detail, updated:latest.versionId==='v2', sameDocument:firstDocument===document, mainStorage:localStorage.getItem('main-canary'), mainGlobal:typeof window.mainCanary, stale };
    for (const [key,command,args] of [
      ['native','sign_event',{event:{}}],
      ['spoof','isolated_panel_request',{request:{op:'save_page',version:'v2',content:'overwrite',channelId:'other'}}],
      ['plugin','plugin:event|emit',{event:'probe',payload:null}],
    ]) {
      try { await window.__TAURI_INTERNALS__.invoke(command,args); result[key]='ALLOWED'; }
      catch(error) { result[key]=String(error); }
    }
    await api.prefs.set('probe',result);
  })().catch(error=>api.prefs.set('probe',{error:String(error),body:document.body.innerText}));
}};
"#).unwrap();
    std::fs::write(home.path().join("settings.json"), r#"{"extensionPermissions":{"page-probe":["ui","read:channels","read:agents","sign","publish"]}}"#).unwrap();
    let mut context = tauri::generate_context!();
    let mut window_config = context.config().app.windows[0].clone();
    window_config.label = "main".into();
    window_config.title = "Fez overlay probe".into();
    window_config.url = tauri::WebviewUrl::App("isolated-panel.html".into());
    window_config.visible = hold;
    window_config.focus = false;
    window_config.incognito = true;
    if plain { window_config.transparent = false; window_config.window_effects = None; }
    context.config_mut().identifier = "chat.fez.overlay-probe".into();
    context.config_mut().app.windows.clear();
    let path = home.path().join("extension-data/page-probe.json");
    let success = Arc::new(AtomicBool::new(false));
    let outcome = success.clone();
    let production_handler = isolated_panel::guard(tauri::generate_handler![isolated_panel::open_isolated_panel, isolated_panel::update_isolated_panel, isolated_panel::close_isolated_panel, isolated_panel::isolated_panel_request, isolated_panel::isolated_panel_host_request, isolated_panel::isolated_panel_reply]);
    let paint_handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![probe_paint]);
    let app = tauri::Builder::default()
        .channel_interceptor(isolated_panel::channel_message)
        .manage(isolated_panel::PanelHost::new(home.path().to_owned()))
        .invoke_handler(move |invoke| {
            if invoke.message.command() == "probe_paint" { paint_handler(invoke) }
            else { production_handler(invoke) }
        })
        .setup(move |app| {
            tauri::WebviewWindowBuilder::from_config(app, &window_config)?
                .initialization_script(PAINT_SCRIPT)
                .initialization_script(r#"
window.mainCanary='private';localStorage.setItem('main-canary','private');
document.addEventListener('DOMContentLoaded',async()=>{
  document.body.style.cssText='margin:0;background:#21483b;color:white;';
  document.body.insertAdjacentHTML('afterbegin','<div style="height:40px;padding-left:80px;line-height:40px">Fez overlay probe — open the board card, then Close or Escape</div>');
  const ipc=window.__TAURI_INTERNALS__;
  const page={content:'## Backlog\n\n- [ ] Fixture card @fez\n  Fixture card detail\n\n## Review\n',title:'Fixture board',channelId:'fixture',slug:'fixture',versionId:'v1',editable:true};
  let version=1;
  const callback=ipc.transformCallback(async({message:id,end})=>{
    if(end)return;
    let result;
    try {
      const op=await ipc.invoke('isolated_panel_host_request',{id});
      let value=null;
      if(op.op==='read_page')value={...page,editable:op.can_edit};
      else if(op.op==='get_config')value={value:{reviews:[]}};
      else if(op.op==='save_page'||op.op==='comment_page'){
        if(op.version!==page.versionId)throw Error('document changed');
        if(op.op==='save_page'){page.content=op.content;page.versionId='v'+(++version);}
        else if(op.anchor!=='- [ ] Fixture card @fez'||op.mentions[0]!=='fez')throw Error('comment was not scoped');
      } else throw Error('unsupported host request');
      result={Ok:value};
    } catch(error){result={Err:String(error)};}
    await ipc.invoke('isolated_panel_reply',{id,result});
  });
  await ipc.invoke('open_isolated_panel',{name:'page-probe',pageView:'▦ board',agents:[['a'.repeat(64),'fez']],hostRequests:'__CHANNEL__:'+callback,bounds:{x:20,y:40,width:innerWidth+100,height:innerHeight+100},appearance:'--bg0:#262335;--bg1:#241b2f;--fg:#f0eff1;--fg-dim:#848bbd;--hairline:#34294f;--accent:#ff7edb;color-scheme:dark;'});
  await window.probePaint('main-before-details');
},{once:true});
"#).build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut observed_details = false;
                let mut instrumented_board = false;
                let mut inspected_details = false;
                for _ in 0..if hold { 3000 } else { 150 } {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if !instrumented_board {
                        if let Some(board) = handle.webviews().values().find(|view| view.label().starts_with("extension-panel-")) {
                            let viewport = board.window().inner_size().unwrap();
                            let position = board.position().unwrap();
                            let size = board.size().unwrap();
                            println!("CLIPPED initial board: position={position:?} size={size:?} viewport={viewport:?}");
                            assert!(position.x >= 0 && position.y >= 0);
                            let rounding = board.window().scale_factor().unwrap().ceil() as u32;
                            assert!(position.x as u32 + size.width <= viewport.width + rounding && position.y as u32 + size.height <= viewport.height + rounding, "oversized initial bounds must be clipped inside the window plus one logical pixel of rounding tolerance");
                            board.eval(PAINT_SCRIPT).unwrap(); instrumented_board = true;
                        }
                    }
                    if let Some(overlay) = handle.webviews().values().find(|view| view.label().starts_with("extension-details-")) {
                        if !observed_details {
                            let size = overlay.window().inner_size().unwrap();
                            assert_eq!(overlay.position().unwrap(), tauri::PhysicalPosition::new(0, 0));
                            assert_eq!(overlay.size().unwrap(), size, "details must cover the entire window");
                            assert_eq!(handle.windows().len(), 1);
                            assert_eq!(handle.webviews().len(), 3, "board remains mounted behind details");
                            observed_details = true;
                            overlay.eval(PAINT_SCRIPT).unwrap();
                            let inspect = r#"void(async()=>{
                                for(let i=0;i<100;i++){
                                    const dialog=document.querySelector('dialog[open]');
                                    if(dialog?.textContent.includes('Fixture card detail') && document.documentElement.dataset.surface==='details'){
                                        if(getComputedStyle(document.body).backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('opaque details body');
                                        await window.probePaint('details-open');
                                        if(!PROBE_HOLD) await window.__TAURI_INTERNALS__.invoke('isolated_panel_request',{request:{op:'close_details'}});return;
                                    }
                                    await new Promise(resolve=>setTimeout(resolve,50));
                                }
                                throw Error('details did not render');
                            })();"#.replace("PROBE_HOLD", if hold { "true" } else { "false" });
                            overlay.eval(inspect).unwrap();
                        }
                    } else if observed_details && !inspected_details {
                        inspected_details = true;
                        let board = handle.webviews().into_values().find(|view| view.label().starts_with("extension-panel-")).unwrap();
                        board.eval("window.probeDetails=true;").unwrap();
                        handle.get_webview("main").unwrap().eval("window.probePaint('main-after-details-close');").unwrap();
                    }
                    let probe = std::fs::read_to_string(&path).ok().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|value| value["prefs"].get("probe").cloned());
                    if let Some(probe) = probe {
                        let passed = inspected_details && handle.windows().len() == 1 && handle.webviews().len() == 2
                            && probe["detail"] == true && probe["updated"] == true && probe["sameDocument"] == true
                            && probe["mainStorage"].is_null() && probe["mainGlobal"] == "undefined"
                            && probe["stale"].as_str().is_some_and(|s| s.contains("document changed"))
                            && probe["native"].as_str().is_some_and(|s| s.contains("denied"))
                            && probe["spoof"].as_str().is_some_and(|s| s.contains("unknown field"))
                            && probe["plugin"].as_str().is_some_and(|s| s.contains("not allowed"));
                        println!("WKWebView page probe: {}\n{}", if passed { "PASS" } else { "FAIL" }, serde_json::to_string_pretty(&probe).unwrap());
                        outcome.store(passed, Ordering::Relaxed);
                        if hold && passed {
                            println!("HOLD: details closed; capture the board and native tree now. Close the probe window to exit.");
                        } else { handle.exit(if passed {0} else {1}); }
                        return;
                    }
                }
                eprintln!("WKWebView page probe timed out"); handle.exit(1);
            });
            Ok(())
        }).build(context).unwrap();
    app.run_return(|_, _| {});
    drop(home);
    std::process::exit(if success.load(Ordering::Relaxed) {0} else {1});
}
