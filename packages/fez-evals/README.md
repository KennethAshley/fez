# @fez/evals

The test gate. 700+ regression tests over fez's measured behaviors — trust boundary, relay wire, crypto, reconnect, git end-to-end against real `git`, cold-start composition, API-mirror conformance, injection payloads. Green here is the bar for "it works." pi's evals idea, fez-shaped.

## Run

```bash
cd packages/fez-evals && npx vitest --run
```

## What it guards

Not just units: whole compositions (a fresh relay through summon, checkout, push, merge), the drift between duplicated surfaces, and every extension's api-types mirror against the real host API.
