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

    // The name becomes a registry key AND a log filename, so it is validated
    // for every caller — a miner is not a second door in.
    #[test]
    fn a_miner_name_is_validated_like_a_persona() {
        assert!(crate::miner_env("../evil", None).is_err());
        assert!(crate::miner_env("a b", None).is_err());
        assert!(crate::miner_env("ember", None).is_ok());
    }

    #[test]
    fn a_miner_relay_must_be_a_relay_url() {
        assert!(crate::miner_env("ember", Some("http://evil")).is_err());
        assert!(crate::miner_env("ember", Some("file:///etc/passwd")).is_err());
        assert!(crate::miner_env("ember", Some("wss://bazaar.fez.chat")).is_ok());
    }

    // A profile goes in; a secret never does. The miner resolves the agent's
    // own key, which is what keeps agent keys out of the desktop entirely.
    #[test]
    fn the_miner_env_carries_a_name_and_no_secret() {
        let env = crate::miner_env("quill", Some("wss://bazaar.fez.chat")).unwrap();
        assert!(env.iter().any(|(k, v)| k == "BAZAAR_PROFILE" && v == "quill"));
        assert!(!env.iter().any(|(k, _)| k.contains("SECRET") || k.contains("KEY")));
    }

    // A row written before miners existed has no `bin`, and every one of them
    // was fez-agent. Reading it back must not make a live agent look dead.
    #[test]
    fn a_registry_row_without_a_bin_reads_as_an_agent() {
        let row: crate::SpawnedAgent = serde_json::from_str(
            r#"{"persona":"scout","channels":["general"],"pid":123}"#,
        )
        .expect("old rows must still parse");
        assert_eq!(row.bin, "fez-agent");
    }
}
