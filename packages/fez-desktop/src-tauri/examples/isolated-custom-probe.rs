//! Packaged macOS custom-view smoke check. Uses a temporary extension and mock
//! host state; the only external operation is an anonymous relay WS handshake.
//! Pass a packed GUI starter directory to test its real bundle with UI-only
//! grants instead. That mode performs no network calls and uses no user state.
#[allow(dead_code)]
#[path = "../src/package_install.rs"] mod package_install;
#[path = "../src/isolated_panel.rs"] mod isolated_panel;
use serde_json::{json, Value};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tauri::Manager;

fn main() {
    let starter = std::env::args_os().nth(1).map(std::path::PathBuf::from);
    let testing_starter = starter.is_some();
    let home = tempfile::tempdir().unwrap();
    let package = home.path().join("packages/custom-probe");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::create_dir_all(home.path().join("extension-data")).unwrap();
    std::fs::write(home.path().join("extension-data/custom-probe.json"), r#"{"fixture":"own state"}"#).unwrap();
    std::fs::write(package.join("package.json"), r#"{"bin":{"fixture-cli":"cli.js"},"fez":{"parts":{"gui":"gui.js"},"guiRuntime":"isolated","guiContributions":{"nav":[{"name":"Fixture","label":"Fixture","glyph":"F"}]}}}"#).unwrap();
    std::fs::write(package.join("gui.js"), r#"
var __fezExt={default:api=>{
    api.registerNavView('Fixture',{glyph:'F',label:'Fixture'},()=>api.React.createElement('h1',null,'Custom fixture'));
    void(async()=>{
        const waitFor=async test=>{for(let i=0;i<200;i++){if(test())return;await new Promise(r=>setTimeout(r,50));}throw Error('fixture timeout');};
        await waitFor(()=>document.body.textContent.includes('Custom fixture'));
        const result={state:await api.storage.get('fixture'), mainStorage:localStorage.getItem('main-canary'),mainGlobal:typeof window.mainCanary};
        result.ownedProcess=JSON.parse((await api.processes.run('fixture-cli',['status'])).stdout).ok;
        try{await api.processes.run('fez-agent',[]);result.otherProcess='ALLOWED';}catch(e){result.otherProcess=String(e);}
        try{await window.__TAURI_INTERNALS__.invoke('get_identity',{});result.identity='ALLOWED';}catch(e){result.identity=String(e);}
        let blocked=false;
        document.addEventListener('securitypolicyviolation',e=>{if(e.effectiveDirective==='connect-src')blocked=true;});
        try{await fetch('https://example.com/');result.deniedNetwork='ALLOWED';}catch{result.deniedNetwork='denied';}
        await waitFor(()=>blocked);result.cspBlocked=blocked;
        result.relay=await new Promise((resolve,reject)=>{
            const ws=new WebSocket('wss://relay.fez.chat');
            const timer=setTimeout(()=>{ws.close();reject(Error('relay handshake timeout'));},10000);
            ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true);};
            ws.onerror=()=>{clearTimeout(timer);reject(Error('approved relay connection failed'));};
        });
        result.agent=api.client.agents().get('a'.repeat(64));
        await api.prefs.set('probe',result);
    })().catch(error=>api.prefs.set('probe',{error:String(error),body:document.body.innerText}));
}};
"#).unwrap();
    let mut surface = json!({"kind":"nav","name":"Fixture"});
    let mut grants = json!(["ui","read:channels","read:agents","processes","network:.fez.chat"]);
    if let Some(source) = starter {
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(source.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest["fez"]["guiRuntime"], "isolated");
        assert_eq!(manifest["fez"]["parts"]["gui"], "dist/view.js");
        grants = manifest["fez"]["permissions"].clone();
        assert_eq!(grants, json!(["ui"]));
        surface["name"] = manifest["fez"]["guiContributions"]["nav"][0]["name"].clone();
        assert!(surface["name"].as_str().is_some_and(|name| !name.is_empty()));
        std::fs::create_dir_all(package.join("dist")).unwrap();
        std::fs::write(package.join("package.json"), manifest.to_string()).unwrap();
        let bundle = std::fs::read_to_string(source.join("dist/view.js")).unwrap();
        // Observe the unchanged generated bundle after the production loader
        // activates it. Report through the same permission-checked prefs broker.
        let observer = r#"
;void(async()=>{
    const report=value=>window.__TAURI_INTERNALS__.invoke('isolated_panel_request',{request:{op:'set_preference',key:'probe',value}});
    try {
        for(let i=0;i<100;i++) {
            const heading=document.querySelector('h1'), card=document.querySelector('.bg-fez-surface');
            if(heading?.textContent===__TITLE__ && card && document.body.textContent.includes('ready')) {
                await report({mounted:true,empty:card.textContent.includes('Nothing here yet.'),
                    background:getComputedStyle(card).backgroundColor,
                    titleSize:getComputedStyle(heading).fontSize,
                    mainStorage:localStorage.getItem('main-canary'),mainGlobal:typeof window.mainCanary});
                return;
            }
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        throw Error('starter did not render');
    } catch(error) { await report({error:String(error),body:document.body.innerText}); }
})();
"#.replace("__TITLE__", &surface["name"].to_string());
        std::fs::write(package.join("dist/view.js"), format!("{bundle}\n{observer}")).unwrap();
        let styles = source.join("dist/view.css");
        if styles.exists() { std::fs::copy(styles, package.join("dist/view.css")).unwrap(); }
    }
    std::fs::write(home.path().join("settings.json"), json!({"extensionPermissions":{"custom-probe":grants}}).to_string()).unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let path = home.path().join("extension-data/custom-probe.json");
    let success = Arc::new(AtomicBool::new(false));
    let outcome = success.clone();
    let app = tauri::Builder::default().channel_interceptor(isolated_panel::channel_message)
        .manage(isolated_panel::PanelHost::new(home.path().to_owned()))
        .invoke_handler(isolated_panel::guard(tauri::generate_handler![isolated_panel::open_isolated_panel, isolated_panel::update_isolated_panel, isolated_panel::close_isolated_panel, isolated_panel::isolated_panel_request, isolated_panel::isolated_panel_host_request, isolated_panel::isolated_panel_reply]))
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("isolated-panel.html".into()))
                .visible(false).inner_size(1000.0,700.0).incognito(true)
                .initialization_script(&r#"
window.mainCanary='private';localStorage.setItem('main-canary','private');
document.addEventListener('DOMContentLoaded',async()=>{
    const ipc=window.__TAURI_INTERNALS__;
    const surface=__SURFACE__;
    const callback=ipc.transformCallback(async({message:id,end})=>{
        if(end)return;let result;
        try{
            const op=await ipc.invoke('isolated_panel_host_request',{id});
            if(op.op!=='custom'||op.name!=='custom-probe')throw Error('wrong bound identity');
            let value;
            if(op.action==='snapshot')value={surface,grants:op.grants,pubkey:'b'.repeat(64),owner:'b'.repeat(64),channels:[],workspaces:[],names:[['a'.repeat(64),'fez']],pubkeysByName:[['fez','a'.repeat(64)]],agents:[['a'.repeat(64),'fez']],reactions:[],receipts:[]};
            else if(op.action==='process_run'&&op.args.bin==='fixture-cli')value={code:0,stdout:'{"ok":true}',stderr:''};
            else throw Error('unexpected host operation');
            result={Ok:value};
        }catch(error){result={Err:String(error)};}
        await ipc.invoke('isolated_panel_reply',{id,result});
    });
    await ipc.invoke('open_isolated_panel',{name:'custom-probe',custom:surface,agents:[['a'.repeat(64),'fez']],hostRequests:'__CHANNEL__:'+callback,bounds:{x:50,y:50,width:900,height:600},appearance:'--bg0:#262335;--bg1:#302d41;--fg:#f0eff1;color-scheme:dark;'});
},{once:true});
"#.replace("__SURFACE__", &surface.to_string())).build()?;
            let handle=app.handle().clone();
            std::thread::spawn(move||{
                for _ in 0..150 {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let probe=std::fs::read_to_string(&path).ok().and_then(|s|serde_json::from_str::<Value>(&s).ok()).and_then(|v|v["prefs"].get("probe").cloned());
                    if let Some(probe)=probe {
                        let passed=handle.windows().len()==1 && handle.webviews().len()==2
                            && probe["mainStorage"].is_null() && probe["mainGlobal"]=="undefined"
                            && if testing_starter { probe["mounted"]==true && probe["empty"]==true && probe["background"]=="rgb(48, 45, 65)" && probe["titleSize"]=="24px" }
                            else { probe["state"]=="own state"
                            && probe["ownedProcess"]==true && probe["otherProcess"].as_str().is_some_and(|s|s.contains("does not ship"))
                            && probe["identity"].as_str().is_some_and(|s|s.contains("denied"))
                            && probe["deniedNetwork"]=="denied" && probe["cspBlocked"]==true && probe["relay"]==true && probe["agent"]=="fez" };
                        println!("WKWebView custom probe: {}\n{}",if passed{"PASS"}else{"FAIL"},serde_json::to_string_pretty(&probe).unwrap());
                        outcome.store(passed,Ordering::Relaxed);handle.exit(if passed{0}else{1});return;
                    }
                }
                eprintln!("WKWebView custom probe timed out");handle.exit(1);
            });Ok(())
        }).build(context).unwrap();
    app.run_return(|_,_|{});drop(home);
    std::process::exit(if success.load(Ordering::Relaxed){0}else{1});
}
