# Ridges local coding baseline

A small local-only candidate for `development.evaluate`, not a production miner. It searches tracked source for symbols mentioned in the issue, asks Claude Sonnet 4.6 to select up to six files, then requests up to eight exact replacements. It returns a Git patch and restores the original checkout. Both calls require provider-supported JSON schemas.

Use a dedicated OpenRouter inference key limited to **$5 or less**, with no reset and no Anthropic provider key configured under workspace BYOK. The candidate checks the credit limit before each call and restricts routing to Anthropic without fallbacks. The UI does not expose the API's `include_byok_in_limit` setting; do not require users to find that checkbox. If Anthropic BYOK is configured, verify that external charges are covered before running. Enter the key only in Mining's private setup field.

Copy this folder into its own Git repository and commit it. Link `agent.py` in Ridges development, select the official evaluator and materialized task, and explicitly evaluate. It uses the local runner's `RIDGES_INFERENCE_*` environment and is not ready for production upload. Use `DOCKER_DEFAULT_PLATFORM=linux/amd64` for x86-only tasks on Apple Silicon.

Run `python3 -B test_agent.py` for offline checks. Fez's eval suite invokes these checks too.

Measured on `swebench-verified@1.0` / `astropy__astropy-7166`: the initial filename-only candidate failed all seven graded tests. Symbol search reached six passes and one failure, still reward **0**. Adding generated checks, a check against the original code, and a separate review did not improve that reward. The cheaper two-call candidate is retained.

Limits: bounded search and context, no internal test/repair loop, no new files, no transport retries. No earnings or validator-performance claims. A failed run may cost money; the dedicated key's usage records aggregate billing when the evaluator omits cost.

API references: [current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
