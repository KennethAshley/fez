# Mining development workspace

User-approved direction: configure and create miners through chat and GUI, with a measured improvement loop rather than an upload-only experience.

Architecture: retain existing miner descriptors, configuration/keychain, CLI and MCP. Add an optional descriptor development hook and a local repository/source association per subnet/persona. Both surfaces use the same CLI actions. Keep candidate history outside the deployed-miner state, so development never starts, registers or uploads a miner.

- [x] Expose descriptor setup fields and masked credentials in submission GUI; grant chat tools before status succeeds. Test private inputs, save-only behavior and persona isolation.
- [x] Add repository/source linkage and recorded evaluation runs through shared CLI/MCP/GUI. Hash source/config, capture git revision and evaluator/dataset identity; compare only compatible runs. Test invalid paths, failures, source mutation and isolation. Evaluations run as detached workers to outlive desktop command deadlines.
- [x] Connect Ridges to verified official local evaluation, with explicit paid-evaluation consent and clear prerequisites. No live paid evaluation or upload in automated checks.
- [x] Run focused tests, package builds/typechecks and full evals; review user-facing setup and experiment results. Review caught the desktop command deadline; detached workers and GUI polling cover it. Live Docker smoke evaluation earned reward 1; the real coding baseline passed 6 of 7 verifier tests but earned reward 0. Inference cost totaled $1.134210 within the authorized $5 budget. See the runtime smoke research record for evidence and limitations; competitive performance is not established.

Constraints: no new dependencies, no secrets in chat/history, no automatic spending or deployment, no fabricated performance metrics, preserve unrelated shared work. Generic process customizations remain descriptor-defined; agents create source using their existing coding tools.
