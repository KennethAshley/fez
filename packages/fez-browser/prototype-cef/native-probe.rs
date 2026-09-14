// Isolated native integration harness: no Fez identity, extensions or agents.
#[path = "native.rs"]
mod native;

fn main() {
    let bootstrap = std::env::args_os().nth(1).expect("bootstrap JSON path").into();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External("about:blank".parse()?))
                .title("Fez native browser test")
                .inner_size(1280., 800.)
                .build()?;
            native::start(app).map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(context)
        .expect("build isolated browser host");
    native::initialize_engine(Some(bootstrap)).expect("initialize CEF");
    app.run(|_, event| {
        if matches!(event, tauri::RunEvent::Exit) { native::stop(); }
    });
}
