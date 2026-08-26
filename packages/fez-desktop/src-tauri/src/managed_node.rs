//! A private Node.js runtime + the Claude ACP adapter, provisioned on
//! demand — Buzz's managed-node decision, fez-shaped.
//!
//! The adapter (@agentclientprotocol/claude-agent-acp) cannot be
//! bun-compiled: its SDK loads dynamically at session time, so a frozen
//! binary ships without its engine (found live: "Cannot find package
//! '@anthropic-ai/claude-agent-sdk'" on the very first team intro).
//! Vendor adapters run as real node programs with real node_modules —
//! fez downloads a pinned Node (sha256-verified, atomic install into
//! ~/.fez/runtimes/node) and npm-installs the adapter into
//! ~/.fez/node-tools the first time the user picks the Claude brain.
//! Apple Silicon only, like the rest of the desktop.

use std::path::PathBuf;
use std::process::Command;

pub const MANAGED_NODE_VERSION: &str = "v24.18.0";
const NODE_FILENAME: &str = "node-v24.18.0-darwin-arm64.tar.gz";
const NODE_SHA256: &str = "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1";
pub const CLAUDE_ADAPTER_PKG: &str = "@agentclientprotocol/claude-agent-acp";
pub const CLAUDE_ADAPTER_VERSION: &str = "0.70.0";

fn fez_home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".fez")
}

pub fn node_bin_dir() -> PathBuf {
    fez_home_dir()
        .join("runtimes")
        .join("node")
        .join(MANAGED_NODE_VERSION)
        .join("darwin-arm64")
        .join("bin")
}

pub fn node_tools_bin_dir() -> PathBuf {
    fez_home_dir().join("node-tools").join("bin")
}

pub fn adapter_path() -> PathBuf {
    node_tools_bin_dir().join("claude-agent-acp")
}

fn node_ready() -> bool {
    node_bin_dir().join("node").exists()
}

pub fn adapter_ready() -> bool {
    // The npm bin shim plus the actual package — a shim pointing at a
    // half-removed install must not count.
    adapter_path().exists()
        && fez_home_dir()
            .join("node-tools")
            .join("lib")
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("claude-agent-acp")
            .join("package.json")
            .exists()
}

fn ensure_node_runtime() -> Result<(), String> {
    if node_ready() {
        return Ok(());
    }
    let root = fez_home_dir().join("runtimes").join("node");
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir runtimes: {e}"))?;

    let url = format!("https://nodejs.org/dist/{MANAGED_NODE_VERSION}/{NODE_FILENAME}");
    let archive = root.join(format!("{NODE_FILENAME}.download"));
    let bytes = {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(
            &mut ureq::get(&url)
                .timeout(std::time::Duration::from_secs(300))
                .call()
                .map_err(|e| format!("download node: {e}"))?
                .into_reader(),
            &mut buf,
        )
        .map_err(|e| format!("download node: {e}"))?;
        buf
    };
    // Integrity before anything touches disk paths we execute from.
    let digest = sha256_hex(&bytes);
    if digest != NODE_SHA256 {
        return Err(format!("node archive sha256 mismatch: {digest}"));
    }
    std::fs::write(&archive, &bytes).map_err(|e| format!("write node archive: {e}"))?;

    let temp = root.join("extract.tmp");
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let status = Command::new("/usr/bin/tar")
        .args(["-xzf"])
        .arg(&archive)
        .arg("-C")
        .arg(&temp)
        .status()
        .map_err(|e| format!("tar: {e}"))?;
    if !status.success() {
        return Err("node archive extraction failed".to_string());
    }
    let _ = std::fs::remove_file(&archive);

    let extracted = temp.join(NODE_FILENAME.trim_end_matches(".tar.gz"));
    if !extracted.join("bin").join("node").exists() {
        return Err("extracted node tree is missing bin/node".to_string());
    }
    let final_dir = root.join(MANAGED_NODE_VERSION).join("darwin-arm64");
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&extracted, &final_dir).map_err(|e| format!("install node: {e}"))?;
    let _ = std::fs::remove_dir_all(&temp);
    Ok(())
}

/// Ensure the Claude ACP adapter is installed and runnable: private
/// node runtime, then `npm install -g --prefix ~/.fez/node-tools`.
/// Blocking (called from an async Tauri command); idempotent; the first
/// run downloads ~50MB and takes tens of seconds — the UI says so.
pub fn ensure_claude_adapter() -> Result<String, String> {
    if adapter_ready() {
        return Ok("ready".to_string());
    }
    ensure_node_runtime()?;
    let node_bin = node_bin_dir();
    let npm = node_bin.join("npm");
    let prefix = fez_home_dir().join("node-tools");
    std::fs::create_dir_all(&prefix).map_err(|e| e.to_string())?;
    let path_env = format!(
        "{}:{}",
        node_bin.display(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string())
    );
    let out = Command::new(&npm)
        .args([
            "install",
            "-g",
            &format!("{CLAUDE_ADAPTER_PKG}@{CLAUDE_ADAPTER_VERSION}"),
            "--prefix",
        ])
        .arg(&prefix)
        .args(["--no-fund", "--no-audit"])
        .env("PATH", &path_env)
        .output()
        .map_err(|e| format!("npm: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "adapter install failed: {}",
            err.lines().rev().take(3).collect::<Vec<_>>().join(" | ")
        ));
    }
    if !adapter_ready() {
        return Err("npm reported success but the adapter isn't runnable".to_string());
    }
    Ok("installed".to_string())
}

/// Parse `claude auth status` JSON — the probe behind the SIGN IN card
/// state. Buzz's lesson: "installed" and "signed in" are different
/// claims, and READY may only make the second one.
pub fn parse_claude_auth(output: &str) -> Option<bool> {
    let start = output.find('{')?;
    let v: serde_json::Value = serde_json::from_str(output[start..].trim()).ok()?;
    v.get("loggedIn").and_then(|b| b.as_bool())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::parse_claude_auth;

    #[test]
    fn auth_json_parses_with_and_without_preamble() {
        assert_eq!(parse_claude_auth(r#"{"loggedIn": true, "authMethod": "oauth"}"#), Some(true));
        assert_eq!(parse_claude_auth("some banner\n{\"loggedIn\": false}\n"), Some(false));
        assert_eq!(parse_claude_auth("not json at all"), None);
        assert_eq!(parse_claude_auth(""), None);
    }
}

#[cfg(test)]
mod provision_tests {
    /// The real thing: downloads the pinned node, npm-installs the
    /// adapter into ~/.fez/node-tools. Opt-in (network + ~80MB):
    ///   cargo test managed_provision -- --ignored
    #[test]
    #[ignore]
    fn managed_provision_for_real() {
        let status = super::ensure_claude_adapter().expect("provision failed");
        assert!(status == "ready" || status == "installed");
        assert!(super::adapter_ready());
    }
}
