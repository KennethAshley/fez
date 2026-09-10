# ORO SN15 mining integration

Reviewed 2026-09-10 against [ORO source](https://github.com/ORO-AI/oro/tree/ffb98e581e8976fbe33cc4a3a467eb617d4b0328) and the official documentation. Source revision: `ffb98e581e8976fbe33cc4a3a467eb617d4b0328`.

## Integration decision

Use a miner-only extension, `@fezchat/oro`, on mainnet 15. Reuse Fez Mining's configuration, private credentials, agent tools, source receipt, confirmed submission and development experiment history. ORO validators host submitted code; there is no always-on miner process to provision. No separate ORO GUI or MCP server is needed.

## Agent and evaluation contract

The production entry point is synchronous `agent_main(problem_data)`. Agents use the provided environment binding and dynamic tool schemas, calling the runtime until `done=true`. The old ShoppingBench list-returning example is not the production protocol. Start from `src/agent/environment_agent.py`, not `src/agent/agent.py`.

The official local evaluator selects five tasks from each of seven families in its release archive. The archive digest is `9e5d11c6945edc19e06b730afd5681a035f75827933f958e6bfbcc846a28c73a`. Results are in `oro.local_generated_summary.v1` summaries derived from trusted runtime receipts. Sandbox output and self-reported scores are not authoritative. A failed infrastructure run must not be presented as a completed zero-score experiment.

Current docs explicitly say these 35 local task IDs are not verified against the Backend's current qualifying roster. Local metrics therefore support development comparisons, not a claim of production qualification or earnings. The public model allowlist is live and may change between runs.

Requirements include Docker Compose, a materialized Git LFS archive, a multi-gigabyte search image, at least 16 GB free disk, AMD64 or Docker Desktop emulation, and a provider runtime key. Host inspection found Docker 29.7.2 running and over 200 GB free; Git LFS was not installed, and the initial clone held a 132-byte archive pointer. No paid ORO evaluation or live submission was authorized or performed during initial implementation.

## Submission and credentials

An existing hotkey must be registered on SN15. Live evaluation requires a provider connection on the ORO backend. OpenRouter onboarding uses a management key; Chutes uses OAuth. Those live credentials are separate from the local evaluator's runtime key. Saving Fez setup must not connect a provider, register a hotkey, upload source, or start inference.

Submission attempts can acquire a cooldown even when rejected. The documented normal cooldown is 18 hours, with one request per minute per hotkey. Preserve accepted version UUIDs when status readback is unavailable. Do not automatically retry a submission after a timeout or ambiguous response.

## Sources

- [Quick start](https://docs.oroagents.com/docs/miners/quick-start)
- [Agent interface](https://docs.oroagents.com/docs/miners/agent-interface)
- [Local testing](https://docs.oroagents.com/docs/miners/local-testing)
- [Submitting](https://docs.oroagents.com/docs/miners/submitting)
- [Inference providers](https://docs.oroagents.com/docs/miners/inference-providers)
- [Pinned local runner](https://github.com/ORO-AI/oro/blob/ffb98e581e8976fbe33cc4a3a467eb617d4b0328/subnet/local_generated_validator.py)

## Verification observations

The official archive was downloaded through GitHub's media endpoint at the pinned revision; its SHA256 matches the expected digest. The public OpenRouter model catalog returned HTTP 200. The official reference source passed the actual networkless Docker syntax/entry-point check after installing its pinned Python image; source SHA256 was `5b25402ba4ab9442984603aced4cd6115d0aa12a23264b25c30df573fa927786`. This check does not execute the agent. No live ORO upload or paid benchmark was performed.

The final implementation passed 23 focused ORO checks, plus 9 catalog/permission checks. The complete core + 46-package build and root/ORO typechecks passed. The full suite recorded 1,767 passing tests, three skips and one filesystem-watcher failure; that unchanged watcher test passed when rerun alone. A further offline preflight used the real pinned Git export, native archive extraction, verified EnvPack and Docker Compose configuration validation. It deliberately simulated image availability and stopped before starting services; it was not a benchmark run.

Review fixes include declaring all evaluator fields, allowing local Docker Desktop contexts while rejecting remote daemons, exporting the pinned Git tree instead of importing ignored checkout bytecode, and disabling Git replacement objects. No user wallet or provider key was used for live ORO requests.
