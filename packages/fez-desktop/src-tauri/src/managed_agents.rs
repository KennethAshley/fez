//! Welcome-flow adapter; lifecycle mechanics live in the shared native spawn path.

#[tauri::command]
pub async fn start_managed_agent(persona: String, owner: String, relay: String, channels: String) -> Result<(), String> {
    let channel_list: Vec<String> = channels
        .split(',')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    tauri::async_runtime::spawn_blocking(move ||
        crate::spawn_agent_process(persona, channel_list, owner, relay, None, None, false).map(|_| ()))
        .await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn bad_personas_are_refused_before_any_side_effect() {
        for manual in [false, true] {
            assert!(crate::spawn_agent_process("../evil".into(), vec![], "aabb".into(), "ws://x".into(), None, None, manual).is_err());
            assert!(crate::spawn_agent_process("a b".into(), vec![], "aabb".into(), "ws://x".into(), None, None, manual).is_err());
        }
    }

    fn settings() -> serde_json::Value {
        serde_json::json!({
            "extensionPermissions": {
                "bazaar": ["ui", "processes"],
                "polls": ["ui", "publish"],
            },
        })
    }

    // The bin claim comes from the package's own manifest now, never
    // settings — anyone can hand-edit settings.json, nobody can hand-edit
    // what a package actually shipped.
    fn manifest_with_bin(bins: &[&str]) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> =
            bins.iter().map(|b| ((*b).to_string(), serde_json::json!(format!("dist/{b}.js")))).collect();
        serde_json::json!({ "name": "x", "bin": map })
    }

    #[test]
    fn an_extension_may_start_a_bin_it_shipped() {
        assert!(crate::extension_may_spawn(
            &settings(),
            Some(&manifest_with_bin(&["fez-bazaar-miner"])),
            "bazaar",
            "fez-bazaar-miner"
        )
        .is_ok());
    }

    // The grant is what makes the difference, and it is checked here rather
    // than in the loader — the loader's decision is not binding on a caller
    // that invokes the command directly.
    #[test]
    fn an_extension_without_processes_may_start_nothing() {
        assert!(crate::extension_may_spawn(
            &settings(),
            Some(&manifest_with_bin(&["fez-polls-helper"])),
            "polls",
            "fez-polls-helper"
        )
        .is_err());
    }

    // Claiming someone else's name is possible from the page. It buys only
    // what that extension could already do, and nothing at all if its own
    // manifest has no such bin.
    #[test]
    fn a_bin_another_package_shipped_is_still_refused() {
        assert!(crate::extension_may_spawn(
            &settings(),
            Some(&manifest_with_bin(&["fez-bazaar-miner"])),
            "bazaar",
            "fez-polls-helper"
        )
        .is_err());
    }

    #[test]
    fn a_bin_nobody_installed_is_unreachable_under_any_name() {
        let manifest = manifest_with_bin(&["fez-bazaar-miner"]);
        assert!(crate::extension_may_spawn(&settings(), Some(&manifest), "bazaar", "sh").is_err());
        assert!(crate::extension_may_spawn(&settings(), Some(&manifest), "bazaar", "/bin/sh").is_err());
        assert!(
            crate::extension_may_spawn(&settings(), None, "bazaar", "fez-bazaar-miner").is_err(),
            "no package dir, no spawn"
        );
    }

    // A manifest is a package's own package.json, stored verbatim at install
    // — an attacker-authored package can declare an absolute path or a
    // traversal AS a bin key, not just an innocent name. Presence in the map
    // is not enough: the key must also pass the same bare-filename rule
    // install applies before materializing bins, or PathBuf::join(bin) either
    // discards the base (absolute) or walks out of ~/.fez/bin (traversal).
    #[test]
    fn a_declared_but_unsafe_bin_name_is_refused() {
        let abs = manifest_with_bin(&["/bin/sh"]);
        assert!(
            crate::extension_may_spawn(&settings(), Some(&abs), "bazaar", "/bin/sh").is_err(),
            "declared as a bin key is not enough — an absolute path must still be refused"
        );
        let traversal = manifest_with_bin(&["../../x"]);
        assert!(
            crate::extension_may_spawn(&settings(), Some(&traversal), "bazaar", "../../x").is_err(),
            "declared as a bin key is not enough — a traversal must still be refused"
        );
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

    fn row(persona: &str, bin: &str, pid: u32) -> crate::SpawnedAgent {
        serde_json::from_str(&format!(
            r#"{{"persona":"{persona}","channels":[],"pid":{pid},"bin":"{bin}"}}"#
        ))
        .expect("row must parse")
    }

    // The registry holds more than fez-agent now: a recalled miner runs
    // fez-bazaar-miner, and a name-check against "fez-agent" let it dodge the
    // kill while its row was deleted — an orphan the UI could no longer see
    // or stop. The signal must be gated on the row's OWN bin.
    #[test]
    fn kill_signals_a_row_whose_bin_is_not_fez_agent() {
        let child = std::process::Command::new("/bin/sleep").arg("60").spawn().expect("spawn sleep");
        let pid = child.id();
        let rows = vec![row("miner", "/bin/sleep", pid)];
        let (killed, rest) = crate::kill_decision(
            rows,
            "miner",
            None,
            |r| crate::pid_runs_bin(r.pid, &r.bin),
            |p| std::process::Command::new("/bin/kill")
                .arg(p.to_string())
                .status()
                .map(|s| s.success())
                .unwrap_or(false),
        );
        let mut child = child;
        let _ = child.wait(); // reap
        assert!(killed, "a live sleep row must be signalled");
        assert_eq!(rest.expect("registry must change").len(), 0);
    }

    // A live process that refused the signal keeps its row: deleting it would
    // hide a process we failed to stop, and the next spawn would double it.
    #[test]
    fn a_live_row_that_refused_the_signal_is_kept() {
        let rows = vec![row("miner", "fez-bazaar-miner", 4242)];
        let (killed, rest) = crate::kill_decision(rows, "miner", None, |_| true, |_| false);
        assert!(!killed);
        assert!(rest.is_none(), "the registry must not change");
    }

    // A stale row (pid gone or recycled to some other command) is dropped
    // without any signal being sent at a pid we no longer own.
    #[test]
    fn a_stale_row_is_dropped_without_a_signal() {
        let rows = vec![row("miner", "fez-bazaar-miner", 4242)];
        let (killed, rest) = crate::kill_decision(rows, "miner", None, |_| false, |_| {
            panic!("must not signal a pid that is not running our bin")
        });
        assert!(!killed);
        assert_eq!(rest.expect("stale row must be dropped").len(), 0);
    }

    // One name, two domains: "drift" is a chat agent AND a miner profile.
    // The registry is keyed by persona, so an unscoped kill from the bazaar
    // panel found the CHAT agent's row, passed its (correct!) bin check,
    // and killed the workspace agent instead of the miner. A caller that
    // says which bin it means can only ever reach its own row.
    #[test]
    fn a_bin_scoped_kill_never_touches_the_same_name_in_another_domain() {
        let rows = vec![row("drift", "fez-agent", 100), row("drift", "fez-bazaar-miner", 200)];
        let mut signalled: Vec<u32> = Vec::new();
        let (killed, rest) = crate::kill_decision(
            rows,
            "drift",
            Some("fez-bazaar-miner"),
            |_| true,
            |pid| { signalled.push(pid); true },
        );
        assert!(killed);
        assert_eq!(signalled, vec![200], "only the miner's pid may be signalled");
        let rest = rest.expect("the miner row must be removed");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].bin, "fez-agent", "the chat agent's row must survive");
    }

    // No matching bin, no action: the panel asking to recall a miner this
    // machine never spawned must be a clean no-op, not a fallback to
    // whatever row happens to share the name.
    #[test]
    fn a_bin_scoped_kill_with_no_matching_row_does_nothing() {
        let rows = vec![row("drift", "fez-agent", 100)];
        let (killed, rest) = crate::kill_decision(rows, "drift", Some("fez-bazaar-miner"), |_| true, |_| {
            panic!("no signal without a matching row")
        });
        assert!(!killed);
        assert!(rest.is_none());
    }
}
