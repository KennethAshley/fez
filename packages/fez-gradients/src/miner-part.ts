// src/miner-part.ts — the fez mining-harness descriptor for SN56 (Gradients,
// rayonlabs/G.O.D — "Gradients on Demand", an AutoML tournament subnet).
//
// PINNED FACTS (verified 2026-09-07 against github.com/rayonlabs/G.O.D via
// `gh api`, not guessed):
//   - clone URL:    https://github.com/rayonlabs/G.O.D.git
//   - commit:       ebbd3d729c8c36173eac7022ff9aa29907d7f643 (tip of main,
//                   pushed_at 2026-09-07T20:48:06Z)
//   - python:       3.10 exactly (pyproject.toml `requires-python = ">=3.10"`;
//                   bootstrap.sh installs python3.10 specifically via
//                   deadsnakes when no `python` is on PATH)
//   - install (mirrors the repo's own `task install`, see docs/developer.md
//     + Taskfile.yml `install:`):
//       python3.10 -m venv .venv
//       .venv/bin/pip install --upgrade pip
//       .venv/bin/pip uninstall -y substrate-interface scalecodec cyscale || true
//       .venv/bin/pip install -e .
//     The uninstall-first step is not cosmetic: the Taskfile comment explains
//     fiber >=2.7.0 moved to async-substrate-interface 2.x (which ships
//     `cyscale`, same import namespace as scalecodec/substrate-interface) and
//     `pip install -e .` won't remove the old packages on its own.
//   - config file:  `.1.env` in the repo root, read via uvicorn's
//     `--env-file`. Field names come straight from
//     `ops/tools/config/models.py::MinerConfig` (uppercased by
//     `create_config.py::write_config_to_file`) — NOT guessed:
//       WALLET_NAME, HOTKEY_NAME, SUBTENSOR_NETWORK, NETUID, REFRESH_NODES,
//       MIN_STAKE_THRESHOLD, ENV
//     `task miner-config` normally writes this interactively; we can't drive
//     that wizard through ctx.machine.exec, so start() writes the file
//     directly with the same field names/defaults the wizard would have used
//     for a mainnet miner (subtensor_network=finney, min_stake_threshold=1000).
//   - start command (docs/developer.md "Running A Miner Locally" +
//     Taskfile.yml `miner:`):
//       ENV=DEV uvicorn miner.asgi:app --reload --host 0.0.0.0 --port 7999 \
//         --env-file .1.env --log-level debug
//     uvicorn runs in the foreground (no self-daemonizing) and only exits on
//     crash/signal, so this descriptor blocks on it directly — no
//     detach+poll loop needed. Two deliberate deviations from the literal
//     command, both noted rather than silently "fixed": (1) `--reload`
//     (autorestart-on-file-change) is dev tooling with no purpose under
//     harness supervision, dropped; (2) `--log-level debug` → `info` for a
//     long-lived process. `ENV=DEV` is kept as-is even though it looks like
//     it should be `ENV=prod` — the repo's own Taskfile hardcodes ENV=DEV
//     for `task miner` regardless of what miner-config wrote, so it reads as
//     an internal app-config knob rather than a literal dev/prod switch;
//     changing it silently would be guessing.
//   - port: 7999 must be externally reachable — validators call
//     `GET http://<external_ip>:<external_port>/training_repo/{task_type}`
//     on it. Broadcasting that address is a SEPARATE one-time step from
//     starting the process: `fiber-post-ip` (installed by `pip install -e .`
//     as a console script) posts wallet+ip+port to the metagraph. That is
//     exactly the "subnet-specific enrollment after chain registration" the
//     harness's `register()` hook exists for, so it lives there, not in
//     start(). Docs command:
//       fiber-post-ip --netuid 56 --subtensor.network finney \
//         --external_port 7999 --wallet.name default --wallet.hotkey <hotkey> \
//         --external_ip <ip>
//   - GPU floor: **G.O.D's miner process itself needs no GPU.** It is a
//     small FastAPI/uvicorn service that answers "here is my training
//     repo/commit" — validators run the actual training on their own
//     trainer infrastructure (see docs/developer.md "Trainer" role). The
//     real requirement is `publicEndpoint`: validators call
//     `GET http://<external_ip>:<external_port>/training_repo/{task_type}`
//     on this miner directly, so it needs a machine with a public port — a
//     NAT'd laptop can't serve it. No GPU floor is claimed here.
//
// AMBIGUITY, called out rather than guessed past: the repo's documented
// "Miner Setup" tells you to run `task bootstrap` before `task install`.
// `bootstrap.sh` requires root, installs NVIDIA drivers + Docker + pm2 +
// Node via apt, and can end in `shutdown now -r`. That script is written
// for provisioning a bare Ubuntu box for ANY G.O.D role (validator/trainer
// included) — a rented Lium pod already arrives with GPU drivers and Docker
// (sysbox), and the miner process above touches neither. Running
// bootstrap.sh unattended against an already-provisioned pod risks
// reconfiguring or rebooting out from under the harness for no benefit this
// role needs, so install() below does the miner-relevant subset only
// (python3.10 venv + pip install) and skips bootstrap.sh entirely. If a
// future pod kind lacks python3.10, install() fails loudly (see below)
// rather than silently trying to apt-install it as root.
//
// Testnet is not wired: MinerContext always carries netuid 56 for this
// descriptor, so subtensor.network is hardcoded to `finney` (mainnet); SN56's
// documented testnet pairing is netuid 241 / `--subtensor.network test`.
import type { MinerContext, SubnetMiner } from "@fezchat/extension-api";

const REPO_URL = "https://github.com/rayonlabs/G.O.D.git";
const PINNED_COMMIT = "ebbd3d729c8c36173eac7022ff9aa29907d7f643";
const MINER_PORT = 7999;

function repoDir(workDir: string): string {
  return `${workDir}/G.O.D`;
}

function doneFile(workDir: string): string {
  return `${workDir}/.gradients-installed-${PINNED_COMMIT.slice(0, 12)}`;
}

async function run(ctx: MinerContext, cmd: string, cwd?: string) {
  const r = await ctx.machine.exec(cmd, { cwd, env: ctx.env });
  if (r.code !== 0) {
    throw new Error(`gradients: \`${cmd}\` exited ${r.code}\n${r.stderr || r.stdout}`);
  }
  return r;
}

const gradients: SubnetMiner = {
  netuid: 56,
  name: "gradients",
  // See "GPU floor" above — no GPU is required; the real gate is public
  // reachability (validators call this miner's endpoint directly).
  requirements: { alwaysOn: true, publicEndpoint: true },

  // Idempotent: guarded on a done-file stamped with the pinned commit, so a
  // repeat call (the harness calls install() every start, per the
  // SubnetMiner contract) is a no-op once the venv exists.
  async install(ctx) {
    const dir = repoDir(ctx.workDir);
    const flag = doneFile(ctx.workDir);
    ctx.log(`gradients: checking install at ${dir}`);
    const check = await ctx.machine.exec(`test -f "${flag}"`);
    if (check.code === 0) {
      ctx.log("gradients: already installed, skipping");
      return;
    }
    const script = [
      "set -e",
      `mkdir -p "${ctx.workDir}"`,
      `if [ ! -d "${dir}/.git" ]; then git clone ${REPO_URL} "${dir}"; fi`,
      `cd "${dir}"`,
      `git fetch --depth 50 origin ${PINNED_COMMIT} || git fetch origin`,
      `git checkout ${PINNED_COMMIT}`,
      // python3.10 exactly (pyproject requires-python >=3.10; the repo's own
      // bootstrap.sh installs this specific minor version). Fail loudly
      // instead of silently falling back to whatever `python3` resolves to.
      `command -v python3.10 >/dev/null 2>&1 || { echo "gradients: python3.10 not found on this machine (see rayonlabs/G.O.D bootstrap.sh for the deadsnakes install path)" >&2; exit 1; }`,
      `[ -d .venv ] || python3.10 -m venv .venv`,
      `.venv/bin/pip install --upgrade pip`,
      // fiber >=2.7.0 migrated off substrate-interface/scalecodec onto
      // async-substrate-interface's `cyscale` (same import namespace) —
      // `pip install -e .` won't remove the old ones on its own.
      `.venv/bin/pip uninstall -y substrate-interface scalecodec cyscale || true`,
      `.venv/bin/pip install -e .`,
      `touch "${flag}"`,
    ].join(" && ");
    await run(ctx, script);
    ctx.log("gradients: install complete");
  },

  // Subnet-specific enrollment after the harness's own chain registration:
  // broadcast this axon's external ip/port to the metagraph via fiber-post-ip
  // so validators know where to reach the training-repo endpoint.
  async register(ctx) {
    const dir = repoDir(ctx.workDir);
    const port = ctx.machine.ports.find((p) => p.internalPort === MINER_PORT) ?? ctx.machine.ports[0];
    if (!port) {
      throw new Error(
        `gradients: no external port mapping for ${ctx.persona} — the machine must expose ${MINER_PORT} publicly before fiber-post-ip can run`
      );
    }
    ctx.log(`gradients: posting ip ${port.externalIp}:${port.externalPort} to the metagraph`);
    await run(
      ctx,
      `.venv/bin/fiber-post-ip --netuid 56 --subtensor.network finney --external_port ${port.externalPort} --wallet.name default --wallet.hotkey ${ctx.persona} --external_ip ${port.externalIp}`,
      dir
    );
  },

  // Blocking: uvicorn runs in the foreground and only returns on crash/exit,
  // which is exactly what the harness's "resolves only when mining stops"
  // contract wants — no launch-detached+poll loop needed here.
  async start(ctx) {
    ctx.log(`starting gradients miner as ${ctx.persona} (hotkey ${ctx.hotkey})`);
    const dir = repoDir(ctx.workDir);
    // .1.env field names come from ops/tools/config/models.py::MinerConfig
    // (see the file header) — this replaces `task miner-config`'s
    // interactive wizard for a mainnet miner with the same defaults it uses.
    const envFile = [
      "WALLET_NAME=default",
      `HOTKEY_NAME=${ctx.persona}`,
      "SUBTENSOR_NETWORK=finney",
      "NETUID=56",
      "REFRESH_NODES=True",
      "MIN_STAKE_THRESHOLD=1000",
      "ENV=prod",
      "",
    ].join("\n");
    await run(ctx, `cat > .1.env <<'GRADIENTS_ENV'\n${envFile}GRADIENTS_ENV`, dir);
    // `--reload` (dev-only autorestart-on-file-change) dropped and
    // `--log-level debug` → `info`; `ENV=DEV` kept as the repo's own
    // Taskfile hardcodes it for `task miner` — see file header.
    const r = await ctx.machine.exec(
      `ENV=DEV .venv/bin/uvicorn miner.asgi:app --host 0.0.0.0 --port ${MINER_PORT} --env-file .1.env --log-level info >> miner-child.log 2>&1`,
      { cwd: dir, env: ctx.env }
    );
    if (r.code !== 0) throw new Error(`gradients miner exited ${r.code}`);
  },
};

export default [gradients];
