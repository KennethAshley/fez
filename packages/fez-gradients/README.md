# Gradients testnet miner

This package targets **testnet SN241 only**. It does not enable mainnet SN56.
A public CPU host runs the endpoint on port 7999; validators supply tournament GPUs.
Fez manages the container and its hotkey. Docker Compose is supported by the harness
for multi-service miners, but this endpoint needs only one container.

## Current readiness

The serving integration and submission configuration are implemented. The image
was built and smoke-tested offline on the existing DigitalOcean fez-bazaar host,
then published to `ghcr.io/kennethashley/gradients-miner:testnet-241`.
The descriptor pins the registry's manifest digest in `src/image.ts`. The package
is public, an anonymous Docker pull by digest passed, and the descriptor is installed
locally for testnet configuration.

A running process is not proof of tournament eligibility, scoring, or earnings.
No registration, hosting purchase, participation-balance transfer or tournament
entry is performed by building this package.

## Build and publish the image

On a Docker/buildx host authenticated to a registry namespace you control:

```sh
cd packages/fez-gradients
npm run image:publish -- ghcr.io/YOUR_OWNER/gradients-miner:testnet-241
```

Use a lowercase owner in the actual command. The build pins G.O.D source at
`c4cf8f41a9c773bb6356ce8175bae8f632e74669`, retains its Fiber request authentication,
and runs an import/route smoke check inside the image. Publication writes the real
registry digest to `src/image.ts` and rebuilds `dist/miner.js`. Make the image public
before using it on a host without registry credentials. Review/commit that pin with
the source change; never substitute a made-up digest or a floating tag.

## Configure a submission

Use `fez-wallet network` to check that the wallet says `test`. Fez rejects a network
mismatch rather than silently switching wallets. Discovery also uses that wallet's
endpoint and avoids mainnet Taostats identity enrichment on testnet.

In the Gradients config form, set:

- **Tournament type:** text, image, or environment. Other tournament requests return 404.
- **Public training repository:** GitHub URL without credentials or query parameters.
- **Training commit:** a full 40-character SHA; no implicit example repository is submitted.
- **Min validator stake threshold:** Fiber's request-admission threshold. Confirm the
  testnet validator's stake before choosing a value. This is not your deposit.

The public repository must contain the correct tournament Dockerfile and upstream
LICENSE/NOTICE, and meet the upstream training/output contract. Fez validates URL
and SHA syntax; that does not prove the repository exists or satisfies tournament
requirements. Private repositories and requested supplementary datasets are not
exposed by this version.

After the image is published and config is saved, launch **241** on an existing
SSH/Docker server with public port 7999, or use Fez's provisioner after reviewing its
cost. The endpoint and Fiber registration are fixed to `test`/`241`; old SN56 entries
are not migrated or restarted automatically. The wallet's mainnet-write guard remains.

## Verify before considering it mining

1. Build smoke passes and the image is pullable by digest from the target machine.
2. Wallet registration and Fiber announcement both report testnet netuid 241.
3. A real testnet validator can authenticate and retrieve the chosen repository/commit.
4. The validator accepts and evaluates the submission; confirm scores separately.

Testnet tournament availability and any participation-balance requirements must be
confirmed with the testnet operator. Do not send mainnet TAO to the collection
address in the mainnet documentation for this rehearsal.

## Local checks

```sh
npm test --prefix packages/fez-gradients
npm run check --prefix packages/fez-gradients
npm test --prefix packages/fez-bittensor
cd packages/fez-evals && npx vitest --run tests/gradients-testnet.test.ts
```

Upstream contract: https://github.com/gradients-ai/G.O.D/blob/c4cf8f41a9c773bb6356ce8175bae8f632e74669/docs/miner.md

## Verification record (2026-09-09)

- Existing DO host: `fez-bazaar`; no new droplet created and no miner launched.
- Local Docker tag on that host: `fez-gradients:testnet-241`.
- Registry manifest digest (confirmed by Docker push and RepoDigests):
  `sha256:5e09334fd33d5533139261ee999be8bb14cd475971b23b839af9b0944df1333b`.
- Build-time upstream import/route smoke and a second `--network none` smoke passed.
- Gradients tests: 2 descriptor + 2 Python checks; testnet evals: 4 checks,
  including the built CLI rejecting mainnet before wallet export/registration.
- Mining suite: 172 passed, 7 live tests skipped. Bittensor suite: 3 passed.
- Root and changed-package typechecks passed. Final full eval gate:
  1417 passed, 1 skipped (146 passing files, 1 skipped file).
- Rebuilt mining GUI, headless extension and launcher links installed locally;
  installed GUI bytes match the build. Wallet still reports `test`.
- Publication succeeded after granting `write:packages`. Temporary registry
  credentials on the build host were removed after pushing. Public visibility
  and an anonymous pull by digest verified; installed descriptor reports SN241
  and the required training repository/commit fields.
- Installed CLI catalog refresh against testnet returned 561 subnets, including
  `gradients (testnet)` at 241, with covered descriptors `[553, 241]`.
- Training repository choice and actual testnet validator evaluation are pending.
