//! Development-only macOS CEF child view. Compiled into Fez only with `cef-prototype`.
use cef::*;
use objc2::{class, ffi, msg_send, rc::Retained, runtime::{AnyClass, AnyObject, AnyProtocol, Bool, Imp, ProtocolBuilder, Sel}, sel, Encode, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSView, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSTimer};
use serde::Deserialize;
use std::{cell::RefCell, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, OnceLock}, time::{Duration, Instant}};
use tauri::Manager;

#[derive(Deserialize)]
struct Bootstrap { profile: PathBuf, url: String, port: i32 }

struct NativeBrowser { browser: Browser, view: Retained<NSView>, timer: Retained<NSTimer>, _library: library_loader::LibraryLoader }
thread_local! { static NATIVE: RefCell<Option<NativeBrowser>> = const { RefCell::new(None) }; }
thread_local! { static INITIALIZED: RefCell<Option<(Bootstrap, library_loader::LibraryLoader)>> = const { RefCell::new(None) }; }
static RUNNING: AtomicBool = AtomicBool::new(false);
static CLOSED: AtomicBool = AtomicBool::new(false);
static SENDING_EVENT: AtomicBool = AtomicBool::new(false);
static ORIGINAL_SEND: OnceLock<unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject)> = OnceLock::new();

unsafe extern "C-unwind" fn sending(_: &AnyObject, _: Sel) -> Bool { Bool::new(SENDING_EVENT.load(Ordering::Relaxed)) }
unsafe extern "C-unwind" fn set_sending(_: &AnyObject, _: Sel, value: Bool) { SENDING_EVENT.store(value.as_bool(), Ordering::Relaxed); }
unsafe extern "C-unwind" fn pump(_: &AnyObject, _: Sel, _: *mut AnyObject) {
    if RUNNING.load(Ordering::Acquire) { do_message_loop_work(); }
}
unsafe extern "C-unwind" fn send_event(this: &AnyObject, selector: Sel, event: *mut AnyObject) {
    let previous = SENDING_EVENT.swap(true, Ordering::Relaxed);
    // Preserve Tao's command-key handling while satisfying CEF's event-loop contract.
    ORIGINAL_SEND.get().expect("original sendEvent")(this, selector, event);
    SENDING_EVENT.store(previous, Ordering::Relaxed);
}

fn install_app_protocol() -> Result<(), String> {
    // CEF declares these protocols in its header; the host must register them.
    let read_protocol = AnyProtocol::get(c"CrAppProtocol").unwrap_or_else(|| {
        let mut builder = ProtocolBuilder::new(c"CrAppProtocol").expect("allocate CrAppProtocol");
        builder.add_method_description::<(), Bool>(sel!(isHandlingSendEvent), true);
        builder.register()
    });
    let control_protocol = AnyProtocol::get(c"CrAppControlProtocol").unwrap_or_else(|| {
        let mut builder = ProtocolBuilder::new(c"CrAppControlProtocol").expect("allocate CrAppControlProtocol");
        builder.add_protocol(read_protocol);
        builder.add_method_description::<(Bool,), ()>(sel!(setHandlingSendEvent:), true);
        builder.register()
    });
    let protocol = AnyProtocol::get(c"CefAppProtocol").unwrap_or_else(|| {
        let mut builder = ProtocolBuilder::new(c"CefAppProtocol").expect("allocate CefAppProtocol");
        builder.add_protocol(control_protocol);
        builder.register()
    });
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let class = app.as_ref().ok_or("Missing NSApplication")?.class();
        ffi::class_addProtocol((class as *const AnyClass).cast_mut(), (protocol as *const AnyProtocol).cast_mut());
        let get_imp = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel) -> Bool, Imp>(sending);
        let set_imp = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, Bool), Imp>(set_sending);
        let getter_encoding = std::ffi::CString::new(format!("{}@:", Bool::ENCODING)).unwrap();
        let setter_encoding = std::ffi::CString::new(format!("v@:{}", Bool::ENCODING)).unwrap();
        if !ffi::class_addMethod((class as *const AnyClass).cast_mut(), sel!(isHandlingSendEvent), get_imp, getter_encoding.as_ptr()).as_bool()
            || !ffi::class_addMethod((class as *const AnyClass).cast_mut(), sel!(setHandlingSendEvent:), set_imp, setter_encoding.as_ptr()).as_bool() {
            return Err("NSApplication already has CEF event handlers".into());
        }
        let method = class.instance_method(sel!(sendEvent:)).ok_or("Missing sendEvent")?;
        let original = std::mem::transmute::<Imp, unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject)>(method.implementation());
        ORIGINAL_SEND.set(original).map_err(|_| "CEF initialized twice")?;
        let replacement = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject), Imp>(send_event);
        ffi::method_setImplementation((method as *const objc2::runtime::Method).cast_mut(), replacement);
    }
    Ok(())
}

wrap_client! {
    struct NativeClient;
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(NativeLifeSpan::new()) }
    }
}
wrap_life_span_handler! {
    struct NativeLifeSpan;
    impl LifeSpanHandler {
        fn on_before_close(&self, _browser: Option<&mut Browser>) { CLOSED.store(true, Ordering::Release); }
        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 { 1 }
    }
}

pub fn initialize_engine(path: Option<PathBuf>) -> Result<(), String> {
    let path = path.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fez-browser/prototype-cef/native-bootstrap.json"));
    let boot: Bootstrap = serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("Start the native browser broker first: {e}"))?).map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let library = library_loader::LibraryLoader::new(&executable, false);
    if !library.load() { return Err("Unable to load CEF".into()); }
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    install_app_protocol()?;
    let frameworks = executable.parent().unwrap().parent().unwrap().join("Frameworks");
    let helper = frameworks.join("cefsimple Helper.app/Contents/MacOS/cefsimple Helper");
    let settings = Settings {
        browser_subprocess_path: helper.to_string_lossy().as_ref().into(),
        framework_dir_path: frameworks.join("Chromium Embedded Framework.framework").to_string_lossy().as_ref().into(),
        main_bundle_path: executable.parent().unwrap().parent().unwrap().parent().unwrap().to_string_lossy().as_ref().into(),
        root_cache_path: boot.profile.to_string_lossy().as_ref().into(),
        log_file: boot.profile.join("cef.log").to_string_lossy().as_ref().into(),
        cache_path: boot.profile.join("Default").to_string_lossy().as_ref().into(),
        external_message_pump: 1,
        remote_debugging_port: boot.port,
        disable_signal_handlers: 1,
        ..Default::default()
    };
    let args = args::Args::new();
    if initialize(Some(args.as_main_args()), Some(&settings), None, std::ptr::null_mut()) != 1 { return Err("CEF initialization failed".into()); }
    INITIALIZED.with(|state| *state.borrow_mut() = Some((boot, library)));
    Ok(())
}

pub fn start(app: &tauri::App) -> Result<(), String> {
    let (boot, library) = INITIALIZED.with(|state| state.borrow_mut().take()).ok_or("CEF engine must initialize before the Cocoa event loop")?;
    let window = app.get_webview_window("main").ok_or("Missing main Fez window")?;
    let native_window = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    let mtm = MainThreadMarker::new().ok_or("CEF must initialize on the main thread")?;
    // A real child view in the existing Fez window; no CEF top-level window.
    let view = NSView::initWithFrame(NSView::alloc(mtm), NSRect::new(NSPoint::new(600., 0.), NSSize::new(600., 600.)));
    unsafe { (*native_window).contentView().ok_or("Missing content view")?.addSubview(&view); }
    let info = WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() }.set_as_child(Retained::as_ptr(&view) as *mut _, &Rect { x: 0, y: 0, width: 600, height: 600 });
    let mut client = NativeClient::new();
    let browser = browser_host_create_browser_sync(Some(&info), Some(&mut client), Some(&boot.url.as_str().into()), Some(&BrowserSettings::default()), None, None).ok_or("CEF child browser creation failed")?;
    RUNNING.store(true, Ordering::Release);
    // Run outside Tao's event callback: CEF pumps nested Cocoa events, which would
    // otherwise re-enter Tao while its event-handler mutex is held.
    // ponytail: fixed 10ms timer for this probe; use CEF scheduled-work callbacks before shipping.
    let timer = unsafe {
        let target: &AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let callback = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject), Imp>(pump);
        ffi::class_addMethod((target.class() as *const AnyClass).cast_mut(), sel!(fezPumpCEF:), callback, c"v@:@".as_ptr());
        NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(0.01, target, sel!(fezPumpCEF:), None, true)
    };
    NATIVE.with(|state| *state.borrow_mut() = Some(NativeBrowser { browser, view, timer, _library: library }));
    eprintln!("Native CEF child view initialized");
    Ok(())
}

pub fn stop() {
    if !RUNNING.swap(false, Ordering::AcqRel) { return; }
    NATIVE.with(|state| {
        if let Some(native) = state.borrow_mut().take() {
            native.timer.invalidate();
            if let Some(host) = native.browser.host() { host.close_browser(1); }
            let deadline = Instant::now() + Duration::from_secs(5);
            while !CLOSED.load(Ordering::Acquire) && Instant::now() < deadline {
                do_message_loop_work(); std::thread::sleep(Duration::from_millis(5));
            }
            native.view.removeFromSuperview();
            drop(native.browser);
            if CLOSED.load(Ordering::Acquire) { shutdown(); }
            else { eprintln!("CEF close timed out; retaining framework until process exit"); std::mem::forget(native._library); return; }
        }
    });
}
