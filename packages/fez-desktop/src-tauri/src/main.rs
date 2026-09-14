// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg_attr(feature = "native-browser", tauri_runtime_cef::cef_entry_point)]
fn main() {
    fez_desktop_lib::run()
}
