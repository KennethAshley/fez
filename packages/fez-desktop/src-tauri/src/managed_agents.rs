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

    fn settings() -> serde_json::Value {
        serde_json::json!({
            "extensionPermissions": {
                "bazaar": ["ui", "processes"],
                "polls": ["ui", "publish"],
            },
            "extensionBins": {
                "bazaar": ["fez-bazaar-miner"],
                "polls": ["fez-polls-helper"],
            },
        })
    }

    #[test]
    fn an_extension_may_start_a_bin_it_shipped() {
        assert!(crate::extension_may_spawn(&settings(), "bazaar", "fez-bazaar-miner").is_ok());
    }

    // The grant is what makes the difference, and it is checked here rather
    // than in the loader — the loader's decision is not binding on a caller
    // that invokes the command directly.
    #[test]
    fn an_extension_without_processes_may_start_nothing() {
        assert!(crate::extension_may_spawn(&settings(), "polls", "fez-polls-helper").is_err());
    }

    // Claiming someone else's name is possible from the page. It buys only
    // what that extension could already do, and nothing at all if it has no
    // such bin.
    #[test]
    fn a_bin_another_package_shipped_is_still_refused() {
        assert!(crate::extension_may_spawn(&settings(), "bazaar", "fez-polls-helper").is_err());
    }

    #[test]
    fn a_bin_nobody_installed_is_unreachable_under_any_name() {
        assert!(crate::extension_may_spawn(&settings(), "bazaar", "sh").is_err());
        assert!(crate::extension_may_spawn(&settings(), "bazaar", "/bin/sh").is_err());
        assert!(crate::extension_may_spawn(&serde_json::json!({}), "bazaar", "fez-bazaar-miner").is_err());
    }

    // Env says what the daemon does, never how it loads.
    #[test]
    fn loader_variables_are_refused() {
        let deny = ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS", "PATH", "path"];
        for k in deny {
            assert!(
                crate::checked_env(vec![(k.to_string(), "x".into())]).is_err(),
                "{k} should be refused"
            );
        }
        assert!(crate::checked_env(vec![("BAZAAR_RELAY".into(), "wss://x".into())]).is_ok());
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
