//! Desktop-managed agents — the onboarding trio's start-on-welcome path.
//!
//! One spawn primitive lives in lib.rs (`spawn_agent_process`): validation,
//! env, detached spawn, reap thread, the pid registry, and the
//! sentinel-deferral gate all happen there — Buzz's bottleneck pattern
//! ("no caller can bypass this by reaching spawn_agent_child directly"),
//! fez-shaped: our processes stay DETACHED and survive the app, tracked in
//! ~/.fez/desktop-agents.json rather than an in-memory child table.
//!
//! This module is deliberately just the policy wrapper the welcome flow
//! calls: same command name and signature the onboarding UI already uses,
//! channels as the comma-joined string it sends. Stopping is `kill_agent`,
//! liveness is `agent_alive` — the registry is the one record.

#[tauri::command]
pub fn start_managed_agent(persona: String, owner: String, relay: String, channels: String) -> Result<(), String> {
    let channel_list: Vec<String> = channels
        .split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    // Already running (registry pid alive, name-checked)? The welcome flow
    // re-fires on every boot; a live agent is success, not an error.
    if crate::agent_is_alive(&persona) {
        return Ok(());
    }
    crate::spawn_agent_process(persona, channel_list, owner, relay, None, None).map(|_| ())
}

#[cfg(test)]
mod tests {
    #[test]
    fn bad_personas_are_refused_before_any_side_effect() {
        assert!(crate::spawn_agent_process("../evil".into(), vec![], "aabb".into(), "ws://x".into(), None, None).is_err());
        assert!(crate::spawn_agent_process("a b".into(), vec![], "aabb".into(), "ws://x".into(), None, None).is_err());
    }
}
