/// The stock desktop plugin discards notification responses on macOS.
/// Return the interaction for this banner without sharing a "last target".
#[tauri::command]
pub async fn notify_with_click(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    if title.len() > 512 || body.len() > 2048 {
        return Err("Notification text is too long".into());
    }
    #[cfg(target_os = "macos")]
    {
        let identifier = if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };
        tauri::async_runtime::spawn_blocking(move || {
            use mac_notification_sys::error::{ApplicationError, Error};
            match mac_notification_sys::set_application(&identifier) {
                Ok(()) | Err(Error::Application(ApplicationError::AlreadySet(_))) => {}
                Err(error) => return Err(error.to_string()),
            }
            let response = mac_notification_sys::Notification::new()
                .title(&title)
                .message(&body)
                .wait_for_click(true)
                .send()
                .map_err(|e| e.to_string())?;
            Ok(matches!(
                response,
                mac_notification_sys::NotificationResponse::Click
            ))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        // libnotify prints the activated action's name on stdout, and --action
        // implies --wait, so one blocking call answers the same question
        // wait_for_click answers on macOS. A daemon that ignores actions closes
        // the banner instead, which reads as "not clicked" — never as a click.
        tauri::async_runtime::spawn_blocking(move || {
            let output = std::process::Command::new("notify-send")
                .arg("--app-name=Fez")
                .arg("--action=default=Open")
                // The separator keeps a title or body that starts with a dash
                // out of libnotify's own option parsing.
                .arg("--")
                .arg(&title)
                .arg(&body)
                .output()
                .map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound =>
                        "Native notification clicks need notify-send (libnotify)".to_string(),
                    _ => e.to_string(),
                })?;
            if !output.status.success() {
                return Err(format!("notify-send could not post the notification ({})", output.status));
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim() == "default")
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (app, title, body);
        Err("Native notification clicks unavailable on this platform".into())
    }
}
