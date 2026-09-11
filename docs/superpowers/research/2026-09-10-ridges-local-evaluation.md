# Ridges local evaluation adapter

Inspected official commit `56406a15eccfca8417030e87b9d0ef34cbcd8d5a` on
2026-09-10. Downloaded source: `/tmp/fez-ridges-official-research`.
The [local-testing guide](https://docs.ridges.ai/guides/local-testing) returned
HTTP 200 via curl after the web reader failed. No paid inference or live Docker
evaluation was run. Relaxed official local Docker mode is the authorized
**development** target; reproducing production sandbox restrictions is not a
prerequisite.

## Verified invocation and result contract

The [official README](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/README.md)
documents installing the miner extra and running:

```sh
ridges miner run-local --task-path /absolute/local/task --agent-path /absolute/agent.py --provider openrouter --non-interactive
```

The [command](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/miners/cli/commands/run_local.py)
prints `SUCCEEDED`, `reward: <verifier_reward>`, test counts and artifact paths
(exit 0). Classified evaluation failure exits 1; runner/setup failure exits 2.
A successful run may still have reward zero. These are human-readable outputs;
Fez does not scrape them.

The adapter instead calls the same
[`miners.local_harbor.run_local_task`](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/miners/local_harbor.py)
and [`execution.artifacts.result_from_summary`](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/execution/artifacts.py).
The official converter returns `verifier_reward`, `test_results` and optional
`cost_usd`, and rejects missing/invalid verifier results. Fez transfers only the
numeric reward, pass/fail/skip counts and any reported cost through a strict JSON
bridge. Missing cost remains absent; missing reward fails. Dataset identity is
[`compute_task_digest`](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/ridges_harbor/digest.py)'s
official content-and-mode digest, also passed to the runner for verification.

## Setup and execution boundary

Select a clean official checkout at the reviewed full SHA, an absolute installed
Python executable, and one trusted materialized Harbor task. The pinned
[dependency manifest](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/pyproject.toml)
requires Python 3.12.3–3.13 and Harbor 0.20.0; install the miner dependencies in
that Python environment. Descriptor fields are `evaluation_checkout`,
`evaluation_commit`, `evaluation_python`, `evaluation_task`; the existing
`openrouter_api_key` supplies inference. No wallet, registration, management key
or upload ticket is needed. Fez does not install host dependencies or download
a dataset. The official runner may build/pull Docker images and install baseline
packages inside the task container.

`development.evaluate` runs only on the parent's explicit evaluation request.
Its source may be the parent's retained immutable snapshot anywhere on disk.
Fez creates a private temporary copy and passes its path to the official runner.
[`RidgesMinerAgent`](https://github.com/ridgesai/ridges/blob/56406a15eccfca8417030e87b9d0ef34cbcd8d5a/ridges_harbor/agents.py)
uploads candidate source into Harbor and executes the official runtime **inside
Docker**. The host bridge never imports the candidate. The selected evaluator,
Python installation and task definitions are trusted user inputs; they are not
an arbitrary-code sandbox. Local mode passes the runtime key to the candidate
container and intentionally relaxes production network/budget restrictions.
There is no claimed dollar cap; use a suitably limited provider key.

The official local function globally prunes dangling Docker images in `finally`.
Fez replaces only that module's `prune_dangling_images` reference with an async
no-op in its short-lived Python process. This preserves official runner and
converter behavior without duplicating the Harbor job builder, changing the
checkout, or pruning unrelated images. Harbor's normal trial cleanup remains.
Run only one local evaluation per Docker daemon, as the guide recommends.

The bridge uses isolated Python import flags, a limited inherited environment,
argument arrays (no shell), and stdin for the runtime key. Upstream stdout and
stderr are suppressed; patches, errors, logs and credentials never become
history detail. Private temporary artifacts are deleted in `finally`; parent
snapshots and ledger records remain parent-owned.

Bounds: source and task metadata 1 MiB; task/artifact trees 10,000 entries,
64 MiB per file, 512 MiB total, with symlinks/special files rejected before
hashing or result conversion. Artifact bounds are checked after the run, not a
filesystem quota while Docker runs. Git has a 5-second/64-KiB bound. Agent time
is capped at 600 seconds (upstream uses the lower task timeout); the coroutine
has 900 seconds, then the host kills Python at 960 seconds if cancellation does
not finish. Host stdout/stderr and bridge JSON are bounded to 64 KiB. Forced
termination can leave Docker resources; inspect Docker before retrying. No
blanket cleanup is attempted. An app crash can also leave private temp artifacts.

## Verification and remaining limitation

Targeted tests exercise selected-Python invocation, pin/task rejection, parent
snapshot compatibility, strict result validation, unknown cost, credential
suppression, and artifact deletion after success/failure. A runnable Python
fixture exercises the exact bridge against injected official API seams, including
result conversion and prune suppression; its candidate raises if host-imported.
These checks do not claim a live Docker or paid evaluation succeeded. Live
execution remains untested here; the parent owns final repository-wide checks.
