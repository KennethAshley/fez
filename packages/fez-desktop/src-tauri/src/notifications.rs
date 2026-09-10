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
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body);
        Err("Native notification clicks unavailable on this platform".into())
    }
}
