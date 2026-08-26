//! Desktop-managed agents — Buzz's shape: the app IS the supervisor
//! while it's open. Spawns ~/.fez/bin/fez-agent per persona with the
//! same env the sentinel's agentEnvCmd builds, so an agent behaves
//! identically no matter who started it. The GUI never spawns the
//! sentinel; if a sentinel is already alive (TUI world), we defer.
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static CHILDREN: Mutex<Option<HashMap<String, Child>>> = Mutex::new(None);

pub fn validate_persona(name: &str) -> Result<(), String> {
    if !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err(format!("bad persona name: {name}"))
    }
}

pub fn agent_env(persona: &str, owner: &str, relay: &str, channels: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("FEZ_AGENT_PERSONA".into(), persona.into());
    env.insert("FEZ_AGENT_OWNER".into(), owner.into());
    env.insert("FEZ_RELAY".into(), relay.into());
    env.insert("FEZ_AGENT_CHANNELS".into(), channels.into());
    env
}

fn sentinel_alive() -> bool {
    let Ok(home) = std::env::var("HOME") else { return false };
    let pidfile = std::path::Path::new(&home).join(".fez").join("sentinel.pid");
    let Ok(pid) = std::fs::read_to_string(&pidfile) else { return false };
    let Ok(pid) = pid.trim().parse::<i32>() else { return false };
    // kill -0: process exists (unix). A stale pidfile fails this probe.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[tauri::command]
pub fn start_managed_agent(persona: String, owner: String, relay: String, channels: String) -> Result<(), String> {
    validate_persona(&persona)?;
    if sentinel_alive() {
        return Ok(()); // the TUI world owns spawning right now — never double-spawn
    }
    let mut guard = CHILDREN.lock().unwrap_or_else(|p| p.into_inner());
    let children = guard.get_or_insert_with(HashMap::new);
    if let Some(child) = children.get_mut(&persona) {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(()); // already running
        }
        children.remove(&persona);
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let bin = std::path::Path::new(&home).join(".fez").join("bin").join("fez-agent");
    if !bin.exists() {
        return Err("bundled fez-agent missing from ~/.fez/bin".to_string());
    }
    let logs = std::path::Path::new(&home).join(".fez").join("logs");
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(logs.join(format!("{persona}.desktop.log"))).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&bin)
        .envs(agent_env(&persona, &owner, &relay, &channels))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("couldn't spawn fez-agent for {persona}: {e}"))?;
    children.insert(persona, child);
    Ok(())
}

#[tauri::command]
pub fn managed_agent_status() -> Result<String, String> {
    let mut guard = CHILDREN.lock().unwrap_or_else(|p| p.into_inner());
    let children = guard.get_or_insert_with(HashMap::new);
    let mut map = serde_json::Map::new();
    for (name, child) in children.iter_mut() {
        let running = child.try_wait().map_err(|e| e.to_string())?.is_none();
        map.insert(name.clone(), serde_json::json!(if running { "running" } else { "exited" }));
    }
    Ok(serde_json::Value::Object(map).to_string())
}

#[tauri::command]
pub fn stop_managed_agents() -> Result<(), String> {
    let mut guard = CHILDREN.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(children) = guard.as_mut() {
        for (_, child) in children.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        children.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn env_is_complete_and_safe() {
        let env = agent_env("drift", "aabb", "ws://127.0.0.1:7777", "bootstrap-welcome");
        assert_eq!(env.get("FEZ_AGENT_PERSONA").unwrap(), "drift");
        assert_eq!(env.get("FEZ_AGENT_OWNER").unwrap(), "aabb");
        assert_eq!(env.get("FEZ_RELAY").unwrap(), "ws://127.0.0.1:7777");
        assert_eq!(env.get("FEZ_AGENT_CHANNELS").unwrap(), "bootstrap-welcome");
    }
    #[test]
    fn persona_names_are_validated() {
        assert!(validate_persona("drift").is_ok());
        assert!(validate_persona("../evil").is_err());
        assert!(validate_persona("a b").is_err());
    }
}
