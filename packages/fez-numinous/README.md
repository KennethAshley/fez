# @fezchat/numinous

Manage Numinous forecasting agents through Fez's Mining panel or a persona's
mining tools. This release supports **testnet 155 / SIGNAL** only. Validators
host uploaded Python; an accepted upload persists without a miner process on
your Mac. Fez tracks versions and reported activation.

## Install

Requires **Fez desktop 0.4.33 or newer** on macOS. In **Settings → Extensions**,
install these packages in order (use their exact names in the install field):

1. `@fezchat/wallet` — version 0.1.14 or newer.
2. `@fezchat/mining` — version 0.1.1 or newer.
3. `@fezchat/numinous` — version 0.1.1 or newer.

Older desktop versions and the npm Protocol 0.2.1 CLI cannot install miner
adapters. Update the desktop first. Node 20+ is required to run extension CLIs.

Restart Fez, set Wallet to **test**, and open **Mining → Numinous → Manage**.
Choose your persona and refresh status to adopt an existing upload. For a new
miner, use **Register**, test your Python file, and confirm its submission.
Registration may burn testnet TAO. Docker is required for the local code check;
it is not a persistent miner service.

Optional config `name` is the upload display name, defaulting to
`Fez <persona> SIGNAL`. Attach `mining=npm:@fezchat/mining` to your persona to
manage the same submission from a channel or DM.

## Commands

The generic `fez-mine` submission harness provides these commands after this
extension is installed. `drift` is an example; the adapter always uses the
persona supplied by the caller.

```sh
fez-mine submission status --netuid 155 --persona drift --json
fez-mine submission test --netuid 155 --persona drift --file PATH --json
fez-mine submission submit --netuid 155 --persona drift --file PATH --sha256 HASH --json
fez-mine submission register --netuid 155 --persona drift --json
```

`HASH` must be the SHA256 returned by a successful test of those exact bytes.
`register` is an explicit **harness** operation that may create a hotkey and
spend a testnet registration burn. The adapter does not register. Status and
submit use `fez-wallet export-hotkey PERSONA --existing --json`, which refuses
missing keys without creating them. An existing upload is adopted through
status; it is never automatically re-uploaded.

## Offline testing

The package ships `examples/agent.py`, the unchanged official neutral baseline
from commit `880fa75c3627a5b5560e0ee27628489d74aa5bb2`. It always predicts 0.5.
The npm tarball includes `examples/agent.py`; the desktop installer places only
extension parts. For the desktop, save this minimal neutral predictor as
`numinous-agent.py` and select it in **Manage → Test code**:

```python
async def agent_main(event):
    return {"event_id": event["event_id"], "prediction": 0.5}
```

The packaged upstream baseline's SHA256 is
`9bf54fd0321ca770e8ed06f7aa6f656afaaba4de7a397d28f12ae0a9096b38ab`.
The baseline is copyright (c) 2023 Opentensor, MIT; the upstream license is
included verbatim in `examples/LICENSE`.

A local Docker CLI, running daemon and this pre-pulled image are required:

```sh
docker pull python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534
```

Tests never auto-pull. A missing Docker CLI returns “Docker required”; daemon,
image and candidate failures are reported without captured output.

The candidate must be a nonempty regular file no larger than 1 MiB. Candidate
bytes and a synthetic event arrive over stdin; Python executes **only inside
Docker**. The sandbox uses no network, no host mounts or forwarded environment,
a read-only root, UID/GID 65534, dropped capabilities, no new privileges,
256 MiB memory (no extra swap), 0.5 CPU, 32 PIDs and an 8 MiB temporary directory.
Execution stops after 30 seconds; a separate bounded `docker rm -f` removes its
unique container on every outcome, including timeout. No wallet is opened by
the adapter's test method.

This is a **stdlib-only interface check**, not a replica of the upstream
validator environment. `agent_main(event)` must return a dict with the matching
`event_id` and a finite numeric `prediction` in `[0, 1]` (booleans are rejected).
Optional `memory` must be null or a string of at most 32,768 Unicode characters.
The check runs one event with null memory; it does not exercise memory across
multiple validator intervals, inference calls or forecasting quality.

A successful test writes only a hash, persona, optional public hotkey, image
digest, prediction and timestamp to `numinous-test.json` in the harness work
directory. Retesting invalidates the previous receipt. Submit loads the file
once, verifies the receipt and SHA256, then signs and uploads those same bytes;
it never reopens the file after signing. The harness owns the per-miner lock.

## API and status limits

Every authenticated operation verifies wallet network `test` and exact endpoint
`wss://test.finney.opentensor.ai:443` **before key export**. The only remote origin
is `https://stg.numinous.earth`. Redirects are errors, API bodies are bounded to
1 MiB, subprocess output is capped, and errors never include response bodies,
request headers, keyfile output or subprocess stderr. Private material exists
only in process memory. Dependencies are the same installed
`@polkadot/keyring` / `@polkadot/util-crypto` 14.0.3 used by the verified probe.

Authenticated GET `/api/v3/miner/agents` uses `hotkey:unix_seconds`. Upload POST
`/api/v3/miner/upload_agent` uses `hotkey:sha256` with SR25519, a Base64 Bearer
signature, hex public key, `Miner` and `X-Payload`. Multipart upload always uses
`track=SIGNAL` and filename `agent.py`. There are **no automatic POST retries**;
an ambiguous transport outcome asks the caller to check status before retrying.

Status validates runtime payloads, reads up to ten 100-item pages and rejects
incomplete, duplicate or inconsistent data. It exposes SIGNAL versions newest
first. `phase=pending` describes the latest upload even if an older version is
active; `activeVersionId` independently identifies the highest version whose
reported activation timestamp has arrived. A null/future activation stays
pending. UID enrichment uses read-only `fez-wallet metagraph --netuid 155
--hotkey ADDRESS --require-testnet --json` and may be absent when chain reads fail.
The wallet guard checks the network and exact endpoint in the same configuration
snapshot used to connect. Before key export, the adapter checks Wallet capabilities
and refuses older versions that cannot enforce these guards.

`nextUploadAt` is the latest reported upload time plus the documented three-day
cooldown. The public rules do not specify whether the backend applies cooldown
per track, so the adapter conservatively considers all reported tracks. The
backend remains authoritative. Status/submit each share a 75-second operation
budget, leaving room for the harness network preflight, with
15-second reads/processes and a maximum 20-second POST. A successful
upload's returned version ID survives failed or stale readback; fallback
metadata is explicitly labeled provisional, with a local upload-time estimate.

There is no guessed results endpoint. Reaching a reported activation timestamp
is not proof of validator execution, inference, scoring, forecast quality or
rewards. Cancellation/deletion and credential linking remain unsupported.

## Verification and provenance

```sh
npm run check --prefix packages/fez-numinous
npm run build --prefix packages/fez-numinous
npm test --prefix packages/fez-numinous
```

Tests inject only HTTP/process I/O, use the public `//Alice` development key,
and cover network/identity failures, API pagination, pending versus active
versions, cooldown, real signature verification, exact multipart bytes,
receipt/hash failures, sandbox arguments/output/cleanup and process limits.
They do not call a live API, execute candidate Python on the host or claim a
real Docker execution when Docker is unavailable.
`npm test` also rebuilds and imports the actual ESM bundle in a fresh Node
process, initializes SR25519 with the public development key and verifies a
captured status signature. The bundled dependencies initialize without a
`createRequire` banner.

Contract checked against official commit
[`880fa75c3627a5b5560e0ee27628489d74aa5bb2`](https://github.com/numinouslabs/numinous/tree/880fa75c3627a5b5560e0ee27628489d74aa5bb2):
[upload CLI](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/miner/scripts/upload_agent.py),
[list CLI](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/miner/scripts/list_agents.py),
[agent runner](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/neurons/validator/sandbox/agent_runner.py),
and [miner setup](https://github.com/numinouslabs/numinous/blob/880fa75c3627a5b5560e0ee27628489d74aa5bb2/docs/miner-setup.md).
