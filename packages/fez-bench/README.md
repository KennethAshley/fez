# @fezchat/bench

The proving ground for the router's judgment. A frozen battery grades `@fez`'s choice of who to summon — right pick, over-route penalty, latency — and keeps a scorecard history, so a change to routing is measured, never guessed. DittoBench-inspired, fez-shaped.

## Run

```bash
node packages/fez-bench/dist/runner.js     # the frozen battery
node packages/fez-bench/dist/score.js      # grade your live roster
```

## Why

Routing is the one place a tiny local model competes with a real teammate for every request; a description too broad silently steals work. This is where that regression is caught.

## TypeSafe comparison (opt-in)

Uses the public frozen cases and the same deterministic prelayers as the existing
benchmark. It makes paid requests to TypeSafe; it never summons agents or changes
production routing. Keep `TYPESAFE_API_KEY` in `~/.fez/typesafe.env`, outside the repo.

```bash
npm run build --prefix packages/fez-bench
node --env-file="$HOME/.fez/typesafe.env" packages/fez-bench/dist/typesafe-cli.js --output /tmp/fez-typesafe-report.json
```

Add `--baseline http://127.0.0.1:8080/v1` to compare an OpenAI-compatible router.
Use that router's `FEZ_ORCHESTRATOR_KEY` and `FEZ_ORCHESTRATOR_PROFILE` if needed.
The current baseline discovers its model through `/models`; verify the reported
model matches the one you intend to compare. A failed baseline leaves the completed
TypeSafe report on disk.

The default pins `jev-1.13.0`, with a 5-second timeout per call and no retries.
`TYPESAFE_MODEL` accepts another pinned model ID; `TYPESAFE_TIMEOUT_MS` changes the
timeout. Service errors or malformed answers stop the run rather than score as
correct no-fit decisions. Reports include per-case choices, confidence and
probabilities, p50/p95 latency, and actual token usage. Cost is an estimate using
the September 18, 2026 published Jev 1.13 price.

Confidence is recorded without an arbitrary acceptance threshold. Tune any future
threshold on separate calibration cases and evaluate it on held-out data.
