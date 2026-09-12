# Hippius: isolated Docker storage trial

**Verified 2026-09-09 (America/New_York): both `seed` and `verify` passed on the
existing DigitalOcean host.** The test containers were removed; the 240 KiB named
volume remains. Gradients `fez-241-drift` stayed running with zero restarts.
Image ID: `sha256:1b6661fa259ea26a85500013c69beb6304d989c4ef9234aa511094a70e05abd5`.

Runs the official Arion **v0.1.32** Linux miner and a disposable QUIC test client
inside a network-disabled container. This is a storage protocol check, **not a
registered testnet miner**. The client signs upload requests using a generated
test key; it does not emulate chain registration, scoring, or validator rewards.

## Run

Requires Docker and Compose on Linux amd64 (or Docker Desktop's amd64 emulation).
Build downloads the checksum-pinned official miner and Python test dependencies.
Execution has only loopback networking, no published ports, and no wallet mounts.

From this directory:

1. `docker compose build`
2. `docker compose run --rm storage-test seed`
3. `docker compose run --rm storage-test verify`

The second run creates a new container and reuses the named `miner-data` volume.
It must retrieve the original 64 KiB shard and preserve the miner identity.
`seed` refuses an existing completed trial; use `verify` to repeat the persistence
check. Use a distinct `-p <project-name>` on **every** command for another trial.

The container is limited to 512 MiB RAM, half a CPU, and 64 processes. Its root
filesystem is read-only; only `/tmp` and the project-scoped data volume are writable.
The miner's storage quota is 1 GiB; the test writes one 64 KiB payload plus metadata.
That quota is application-level, not a filesystem quota. The named volume survives
container removal. It contains only generated test identities and test data.

## Assertions

- Invalid upload signatures are rejected.
- Signed uploads with corrupt data are rejected by BLAKE3 validation.
- A signed shard is accepted and retrieved byte-for-byte over QUIC.
- Replacing the container preserves the shard and the mode-0600 miner identity.
- The script refuses to execute with any network interface other than loopback.

The test client permits the miner's self-signed TLS certificate only within this
enforced offline setup. It is not a reusable production client. Each run has a
60-second deadline and shuts its miner subprocess down before exiting.

## What remains before live mining

Hippius uses its own chain and Arion family/child registration. Registering on
Bittensor testnet SN75 does not substitute for that registration. Current chain
source includes a `development` Alice chain, while `dev` selects a different
testnet configuration; neither establishes a reachable public Arion test cluster.
The isolated development-chain registration check below now passes. We still need
a verified **public test-chain RPC and compatible validator/warden setup** to
receive genuine test work. The published Arion workspace at `6a07b7f` excludes
`validator`; `cargo metadata --offline --no-deps --manifest-path validator/Cargo.toml`
fails because the package is not a workspace member. Its published handlers still
use Iroh while the released miner uses Quinn. We have not verified a compatible
deployable validator build; merely restoring that workspace member is not proof.

The published miner guide rejects Docker bridge networking and recommends running
directly on the host. Linux `network_mode: host` is a candidate for a future live
Compose deployment, but this trial does **not** verify that deployment. Keep
identity and shard volumes persistent, give each miner distinct paths/ports, and
check the current capacity requirements before reserving hardware.

## Local chain registration — verified

The **same miner identity** used by the storage test registered successfully on an
isolated Hippius development chain. This does not unlock production or public
testnet mining in Fez.

- Node source: `thenervelab/thebrain@3187525a9317ff70f7157c930124e19858dfe235`;
  runtime spec version **92015**.
- Arion rejected the invalid signature at block **43** and accepted the correctly
  signed registration at block **45**. Its nonce advanced once.
- Registration transaction:
  `0x2eca9494dddfc3d3882b602692e933c385607e5aeaef3ddc8737367cc4b0a772`.
- A separate finality read verified that transaction on the canonical chain and
  the **Active** registration at finalized block **61**. Deposit: **0**.
- **Scope:** Alice sudo seeded the family prerequisite, Alice added Bob as a
  proxy, and the regular `arion.registerChild` call verified the storage miner's
  signature. Public-network coldkey eligibility and rewards were not tested.

The chain used `network_mode: none`, 1.5 GiB RAM and 256 MiB temporary chain disk.
RPC was accessible only through `docker exec` over SSH. No host port was exposed.
The chain was stopped after verification; its test state is disposable. The miner
identity and shard volume remain separate and persistent.

### Repeat the registration trial

1. Obtain the exact official node artifact. From this directory, with `gh` logged in:

   ```sh
   gh api repos/thenervelab/thebrain/actions/artifacts/10112021982/zip > hippius-binary.zip
   python3 - <<'PY'
   from pathlib import Path
   import hashlib, zipfile
   archive = Path('hippius-binary.zip')
   assert hashlib.sha256(archive.read_bytes()).hexdigest() == 'b12b9ecb50fafa64d3f406e1b6e2d62a014cf7de7460531cdec9de26daa03c46'
   with zipfile.ZipFile(archive) as z:
       data = z.read('hippius')
   assert hashlib.sha256(data).hexdigest() == 'b73ea812697e0865ee32de55abf341305f8858e0ed45fe95c908f9ad9880b104'
   node = Path('hippius-current')
   node.write_bytes(data)
   node.chmod(0o755)
   PY
   ```

   GitHub CI artifacts expire. If this artifact is unavailable, verify and pin a
   replacement from the official repository; do not silently use `latest`.

2. On the Docker host, place `hippius-current` beside `compose.chain.yaml` and run
   `docker compose -f compose.chain.yaml up -d`. Allow about **90 seconds** for
   initial genesis execution on the capped server. The storage `seed` trial must
   have already populated `fez-hippius-lab_miner-data` on this same host.

3. From this repository with fez-wallet's dependencies installed, run:

   ```sh
   HIPPIUS_TEST_SSH_HOST=root@your-host node dev/experiments/hippius-compose/chain-smoke.cjs
   ```

   This asserts the chain identity and network isolation before using **only
   Alice/Bob development accounts**. It reads the miner's public key and requests
   a signature inside the storage-test container; private key bytes stay there.
   The script checks inclusion and storage state. The recorded block-61 finality
   check above was performed separately after this run.

Stop the disposable chain afterward with `docker compose -f compose.chain.yaml down`.
Do not use these development flags or accounts for public networks.

## Sources

- [Official miner release](https://github.com/thenervelab/arion/releases/tag/v0.1.32)
- [Miner networking requirements](https://github.com/thenervelab/arion/blob/6a07b7f6ffc3ad017be2b2c785d9797e82bdb10e/miner/README.md)
- [Storage wire protocol](https://github.com/thenervelab/arion/blob/6a07b7f6ffc3ad017be2b2c785d9797e82bdb10e/miner/src/p2p.rs)
- [Chain selection](https://github.com/thenervelab/thebrain/blob/main/node/src/command.rs)
- [Development genesis](https://github.com/thenervelab/thebrain/blob/main/node/src/chainspec/mainnet.rs)
- [Verified node build](https://github.com/thenervelab/thebrain/actions/runs/34367798401)
- [Pinned Arion registration implementation](https://github.com/thenervelab/thebrain/blob/3187525a9317ff70f7157c930124e19858dfe235/pallets/arion-pallet/src/lib.rs)
