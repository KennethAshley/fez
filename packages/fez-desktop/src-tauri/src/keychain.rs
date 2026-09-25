//! The one place a secret leaves this process.
//!
//! macOS keeps secrets in the login keychain through `/usr/bin/security`.
//! Linux keeps them in the Secret Service (gnome-keyring, KWallet, …)
//! through `secret-tool`, under the same service/account pair, so the two
//! platforms address the same entry by the same name.
//!
//! Absence and access failure stay separate on both. The app routes a
//! missing identity to onboarding and a locked or denied store to a retry
//! screen; reading "can't reach the store" as "nothing stored" is the one
//! mistake that would mint a second identity over someone's existing one.

#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "linux")]
use std::{io::Write as _, process::{Command, Stdio}};

/// The stored secret, or `None` when the store is reachable and simply
/// holds nothing under this name. `Err` means the store could not answer.
pub(crate) fn find(service: &str, account: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|e| format!("couldn't run security: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // `security` exits 44 (errSecItemNotFound) when the item is
            // absent; the stderr match is the belt to that suspender.
            if output.status.code() == Some(44) || stderr.contains("could not be found") {
                return Ok(None);
            }
            return Err(stderr.trim().to_string());
        }
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
    }
    #[cfg(target_os = "linux")]
    {
        let output = secret_tool(["lookup", "service", service, "account", account])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // libsecret says nothing at all when there is simply no match,
            // and prints a reason when the store itself refused. Silence is
            // therefore the absence signal — there is no exit code for it.
            if stderr.trim().is_empty() {
                return Ok(None);
            }
            return Err(stderr.trim().to_string());
        }
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
    }
}

/// Whether a secret exists, never its value. A locked or denied store is
/// an error here, not a `false`: "disconnected" and "can't tell" differ.
pub(crate) fn contains(service: &str, account: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account])
            .output()
            .map_err(|e| format!("couldn't run security: {e}"))?;
        match output.status.code() {
            Some(0) => Ok(true),
            Some(44) => Ok(false), // errSecItemNotFound
            _ => Err("keychain access failed".into()),
        }
    }
    #[cfg(target_os = "linux")]
    { find(service, account).map(|secret| secret.is_some()).map_err(|_| "keychain access failed".to_string()) }
}

/// Write a secret. `replace` false means "only if absent".
pub(crate) fn store(service: &str, account: &str, value: &str, replace: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("security");
        command.args(["add-generic-password", "-s", service, "-a", account, "-w", value]);
        // Without -U the keychain also refuses a concurrent CLI's new key;
        // the caller's read-before-write guard cannot make creation atomic.
        if replace {
            command.arg("-U");
        }
        let status = command.status().map_err(|e| format!("couldn't run security: {e}"))?;
        if !status.success() {
            return Err("keychain write failed".to_string());
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        // The Secret Service has no create-if-absent: `store` always
        // replaces. `replace` is honoured by refusing up front instead,
        // which leaves the same window the macOS read-before-write guard
        // leaves, without -U's atomicity. Two processes minting an
        // identity at the same instant can still race.
        if !replace && find(service, account)?.is_some() {
            return Err("keychain write refused: an entry already exists".to_string());
        }
        let mut child = Command::new("secret-tool")
            .args(["store", "--label", &format!("fez: {service}/{account}"),
                   "service", service, "account", account])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(missing_secret_tool)?;
        // secret-tool reads the secret from stdin; no trailing newline, or
        // it becomes part of the stored value.
        child.stdin.take().ok_or("could not pass the secret to secret-tool")?
            .write_all(value.as_bytes())
            .map_err(|e| format!("could not pass the secret to secret-tool: {e}"))?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            return Err(if stderr.is_empty() { "keychain write failed".to_string() }
                       else { format!("keychain write failed: {stderr}") });
        }
        Ok(())
    }
}

/// Forget one secret. A missing entry is success: callers use this to
/// disconnect, which is idempotent.
pub(crate) fn forget(service: &str, account: &str) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("security")
        .args(["delete-generic-password", "-s", service, "-a", account])
        .status();
    #[cfg(target_os = "linux")]
    let _ = secret_tool(["clear", "service", service, "account", account]);
}

/// Forget every secret under a service — the factory reset.
pub(crate) fn forget_service(service: &str) {
    #[cfg(target_os = "macos")]
    {
        // One entry per account; `security` deletes one match per call —
        // loop until the service is empty.
        while Command::new("security")
            .args(["delete-generic-password", "-s", service])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {}
    }
    #[cfg(target_os = "linux")]
    {
        // `clear` removes every item matching the attributes, so the whole
        // service goes in one call.
        let _ = secret_tool(["clear", "service", service]);
    }
}

#[cfg(target_os = "linux")]
fn secret_tool<const N: usize>(args: [&str; N]) -> Result<std::process::Output, String> {
    Command::new("secret-tool").args(args).output().map_err(missing_secret_tool)
}

#[cfg(target_os = "linux")]
fn missing_secret_tool(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound =>
            "couldn't run secret-tool — install libsecret-tools to let Fez use your keyring".to_string(),
        _ => format!("couldn't run secret-tool: {e}"),
    }
}
