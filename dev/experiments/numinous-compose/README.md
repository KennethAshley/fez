# Numinous testnet probe

Throwaway feasibility check for Numinous (formerly Infinite Games, mainnet SN6;
the official miner guide names testnet SN155). Drift's neutral starter is now
registered and submitted on testnet. It is **pending activation**, not yet
verified executing or earning. The reusable [Fez adapter](../../../packages/fez-numinous/README.md)
now manages that existing submission through the mining GUI and persona tools.
This directory retains the original feasibility probe; use the adapter for management.

Verified on 2026-09-09 using official source commit
[`880fa75c3627a5b5560e0ee27628489d74aa5bb2`](https://github.com/numinouslabs/numinous/tree/880fa75c3627a5b5560e0ee27628489d74aa5bb2):

- The unchanged official `agent_runner.py` accepts the official baseline agent.
- The official memory example carries its returned memory between fresh Python
  processes, updating a seeded belief from 0.8 to 0.68 to 0.608.
- The runner rejects a probability of 1.1. The check inspects `output.json`,
  because the upstream runner can exit successfully while reporting an error.

Compose uses a pinned Python 3.11 image, no network, no wallet mounts, an
unprivileged user, read-only root, temporary scratch space, 256 MiB RAM, and
half a CPU. Each upstream input is SHA-256 checked before execution. The
temporary container was removed after the successful run; existing Gradients
and search services remained running.

## Repeat on a Linux Docker host

From this directory, download the three public source files once:

```sh
mkdir -p upstream
NUMINOUS_SOURCE=https://raw.githubusercontent.com/numinouslabs/numinous/880fa75c3627a5b5560e0ee27628489d74aa5bb2
curl -fL "$NUMINOUS_SOURCE/neurons/validator/sandbox/agent_runner.py" -o upstream/agent_runner.py
curl -fL "$NUMINOUS_SOURCE/neurons/miner/agents/hello_world.py" -o upstream/hello_world.py
curl -fL "$NUMINOUS_SOURCE/neurons/miner/agents/memory_example.py" -o upstream/memory_example.py
docker compose run --rm -T smoke
```

Expected output: three `PASS` lines followed by the `OFFLINE ONLY` boundary.
No custom image build or Python dependency installation is needed for these
stdlib-only upstream examples. The full official validator sandbox has more
dependencies; this experiment does not claim to reproduce that entire stack.

## Testnet submission — verified 2026-09-10 03:52 UTC

- Drift's existing remote hotkey registered on **testnet 155 as UID76**.
- Registration transaction: `0xdb847e42e940f117081978792755792c88af41ccb7f64237c7ac09a50f44a53e`.
- Included at block **7972495**, hash `0x16135771e2d327a32393d9c6c7ae9ed025c200801de1ef339ac9bc73dd58475a`;
  verified present with UID76 at finalized block **7972503**.
- Burn: **0.0005 tTAO**. Preflight fee estimate: **0.002141782 tTAO**;
  the estimate is not an exact charged-fee receipt.
- Uploaded the unchanged `hello_world.py` baseline to **test / SIGNAL**.
- Agent version: `14cfd757-78a3-4f46-9cfa-115ff0142ec8`, version number 0.
- API read-back confirms `Fez drift testnet baseline`, UID76 in the upload
  response, and `activated_at: null`. Linked services: **none**.
- The agent always returns 0.5 and makes no inference calls. It proves
  submission plumbing, not forecast quality.

`submit-testnet.cjs` mirrors the official CLI's SR25519 HTTP authentication
using Fez's already-installed dependencies. It loads the existing Drift remote
hotkey into process memory, transmits only signatures/public identity, pins the
staging origin and baseline SHA-256, selects SIGNAL explicitly, and refuses to
replace an existing SIGNAL agent. It neither registers wallets nor links providers.

On the Fez development Mac:

```sh
node dev/experiments/numinous-compose/submit-testnet.cjs self-test
node dev/experiments/numinous-compose/submit-testnet.cjs status
```

The official rules schedule activation at the next **00:00 UTC**: for this
upload, **2026-09-11 00:00 UTC / September 10, 8 p.m. EDT**. This is the documented
schedule, not a confirmed backend activation. They also limit submissions to
once every three days; prepare and test any improved forecasting agent locally
before its next permitted upload.

## Not yet proved

Signing proxy behavior, inference API access, actual forecast quality,
validator execution, scoring, and rewards. The public test event feed was
empty during the anonymous probe, so execution needs a later observed run.

The miner is submitted Python code; validators host its execution. Docker here
is a local development/test harness, not an always-on GPU miner rental.

Sources: [miner setup](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/miner-setup.md),
[official sandbox runner](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/validator/sandbox/agent_runner.py).
