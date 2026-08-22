# @fezchat/bench

The proving ground for the router's judgment. A frozen battery grades `@fez`'s choice of who to summon — right pick, over-route penalty, latency — and keeps a scorecard history, so a change to routing is measured, never guessed. DittoBench-inspired, fez-shaped.

## Run

```bash
node packages/fez-bench/dist/runner.js     # the frozen battery
node packages/fez-bench/dist/score.js      # grade your live roster
```

## Why

Routing is the one place a tiny local model competes with a real teammate for every request; a description too broad silently steals work. This is where that regression is caught.
