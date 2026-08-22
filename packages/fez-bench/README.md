# @fez/bench

A routing bench for the orchestrator. A frozen battery of boundary cases grades `@fez`'s agent selection — right pick, over-route penalty, latency, input hashing — and keeps a scorecard history so a routing change is measured, not guessed. DittoBench-inspired, fez-shaped.

## Run

```bash
node packages/fez-bench/dist/runner.js        # the frozen battery
node packages/fez-bench/dist/score.js         # grade YOUR live roster
```

## Why

Routing is the one place a small local model competes with a real teammate for every request; a description that is too broad silently steals work. The bench is how that regression is caught before it ships.
