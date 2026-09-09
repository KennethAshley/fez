# Container miners — descriptor v2 + provisioned machines

2026-09-09. Designed with Ken the night the first ssh miner went live
(gauss, Gradients testnet-56, on a hand-prepped droplet). That run
found five bugs and demanded four manual host-prep steps; this design
removes the class, not the instances.

## Goal

A user adds one API token, clicks Mine, and a subnet miner is serving
from a machine fez created — no terminal, no python, no host prep.
Two independent halves deliver it:

1. **Container descriptors**: a miner ships as a pinned image, not as
   install instructions. Host prereq shrinks to Docker.
2. **Provisioned machines**: fez can create (and destroy) the machine
   itself, starting with DigitalOcean.

## Non-goals / standing decisions

- **No provider lock-in.** ssh remains the first-class bring-anything
  path (any box with sshd mines today). DO is the *first* provisioner
  behind a generic seam, not the story.
- **No orchestrators** (k8s, Nomad) — one box runs one miner.
- **Bazaar stays script-style.** It is fez's own bun binary running
  locally; containerizing it would add a Docker Desktop prereq for
  nothing. Script descriptors remain fully supported (Ansible-style
  flows, static binaries).
- **`docker run` is the workhorse, compose the dialect.** Single
  containers (the common case) never touch YAML; an upstream
  multi-service `compose.yml` is adopted verbatim when a subnet ships
  one.
- **Images**: upstream's when it exists (digest-pinned), fez-built and
  published to ghcr.io/fezchat when it doesn't. No verification beyond
  digest pinning (content trust later, if ever).

## Descriptor v2 — the `container` block

`SubnetMiner` gains one optional field; the rest of the contract is
untouched. A descriptor with `container` needs no `install`/`start`;
`container` wins when both exist.

```ts
container?: {
  image: string;                      // digest-pinned
  env?: Record<string, string>;       // templates over ctx.config/secrets: { WALLET_NAME: "{walletName}" }
  ports?: { internal: number }[];     // published on the machine's declared external ports
  mountKeys?: boolean;                // /root/.bittensor bind-mounted READ-ONLY
  register?: { command: string[] };   // one-shot in the same image (fiber-post-ip runs HERE)
  compose?: string;                   // verbatim upstream compose.yml; when set, image/ports describe rather than drive
}
```

Key material never enters image or argv: `mountKeys` reuses the
directory `deployHotkey` already populates; secrets go through an
`--env-file` written mode 600 on the machine (ps-safe — the env-leak
lesson from the live run, applied).

## The generic container runner

One module in fez-mining (`container-runner.ts`), driving everything
through `ctx.machine.exec` — the lowest common denominator all machine
kinds share (a Lium pod has no ssh socket to tunnel an engine API
through; Kamal proves exec-driven docker at scale). Structured reads
use `docker ps --format json` / `docker inspect`.

- **ensure-docker**: probe once per machine, done-file guarded.
  Missing → one-line failure naming the fix. Fez-provisioned machines
  never hit it (cloud-init installs Docker).
- **install** = `docker pull <image>`; the digest is the done-file.
- **register** = `docker run --rm` of `container.register.command` in
  the same image, keys mounted, guarded by the harness's existing
  registered-flag.
- **start** = `docker run -d --name fez-<netuid>-<persona>
  --restart unless-stopped` + env-file + ports + mounts, then
  `docker wait` — so the "start resolves only when mining stops"
  contract, supervision, attention DMs, and reconcile all hold with
  zero changes.
- **stop** = `docker rm -f fez-<netuid>-<persona>`. The deterministic
  name closes the remote-orphan gap on the container path (the
  script-descriptor orphan gap remains a separate follow-up).
- **status/logs** = `docker ps --filter` / `docker logs --tail`,
  feeding the same GUI/thread tails as today.
- **compose variant**: the four verbs become
  `compose pull / up -d / down / ps`, project-named identically.

## Provisioner seam + DoMachine

After provisioning, the machine IS an SshMachine — everything
live-proved on 2026-09-08/09 (exec discipline, key deploy,
transportError semantics) is reused verbatim.

```ts
interface Provisioner {
  provision(opts: { netuid: number; persona: string; servePorts: number[] }):
    Promise<{ ref: string; ssh: SshSpec }>;
  alive(ref: string): Promise<boolean>;
  destroy(ref: string): Promise<void>;
}
```

DoMachine, the first implementation:

- **Auth**: `DO_API_TOKEN` in SKILLS & SECRETS (the LIUM_API_KEY
  pattern). Direct REST (`POST/DELETE /v2/droplets`) — no doctl
  dependency.
- **fez's own ssh identity**: an ed25519 pair generated once into
  `~/.fez/ssh/`; the public half rides cloud-init `user_data`. The
  user's DO account keys are never touched.
- **cloud-init**: authorize the fez key, install Docker, disable
  password auth. By the time sshd answers, the box is miner-ready.
- **Lifecycle**: one droplet per miner; **stop destroys it** (API
  DELETE — no orphan possible, no idle billing). Restart
  re-provisions; the Lium reattach pattern applies (alive-check →
  reattach as ssh; dead → fresh provision), including the
  provisions-per-day spend guard and persist-before-deploy (a droplet
  that fails mid-setup must still be findable and destroyable).
- **State**: `MinerMachineState` gains `kind: "do"` = `dropletId` +
  the ssh fields.
- **Cost honesty**: the picker row and confirm step state the hourly
  rate and that it bills the user's DO account until stop. Default
  size `s-1vcpu-2gb` (no pip spike with prebuilt images); size becomes
  a knob only when a descriptor first needs it.
- ponytail: region fixed (account default); a region picker when
  someone outside the US asks.

## GUI

Two touches:

1. Machine step: "DigitalOcean droplet" choice — enabled when
   `DO_API_TOKEN` exists, otherwise visible-but-disabled with "add
   DO_API_TOKEN in SKILLS & SECRETS".
2. Miner rows/detail render `kind: "do"` as
   `· DO droplet <id> · ~$/hr · serving :port` (same pattern as the
   ssh row fix).

## Gradients migration (the proving descriptor)

`fez-gradients` v2 = a `container` block: image (upstream if rayonlabs
ships one, else `ghcr.io/fezchat/gradients-miner` with the pinned
commit baked), `register` = fiber-post-ip inside the image,
`mountKeys: true`, port 7999, env from the same four config fields.
The script `install`/`start`/`register` are deleted — deadsnakes, pip,
and fiber's python become the image's internals. No script fallback
kept (YAGNI).

## Testing

- **Unit**: container-runner command construction (env-file, mounts,
  names, compose variant); DO provisioner reattach/spend-guard state
  machine against a scripted fake API — the `machine-lium.test.ts`
  style.
- **Live** (env-gated, `live-ssh-smoke.test.ts` style): real token →
  provision → Gradients container serving on testnet-56 → endpoint 200
  from outside → stop → **assert the droplet is gone** (billing safety
  is part of the test).

## Build order (independently mergeable)

- **A** — `container` block + generic runner; Gradients converts;
  proven via the existing ssh machine on a manually-made docker
  droplet. No DO code.
- **B** — provisioner seam + DoMachine + GUI row + state/reattach.
- **C** — live end-to-end smoke; npm publish batch rides along
  (extension-api, mining, wallet — with the self-contained-bins build
  fix).
