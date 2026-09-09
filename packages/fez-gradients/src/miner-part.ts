// src/miner-part.ts — the fez mining-harness descriptor for SN56 (Gradients,
// rayonlabs/G.O.D — "Gradients on Demand", an AutoML tournament subnet).
//
// Descriptor v2 (2026-09-09): the miner is an image, not install
// instructions. `container-runner.ts` (fez-mining) pulls, runs, and
// registers this descriptor generically — no per-subnet install()/start()
// code needed here. See Dockerfile for how the image is built.
//
// PINNED FACTS baked into the image (verified 2026-09-07 against
// github.com/rayonlabs/G.O.D via `gh api`, not guessed):
//   - clone URL:    https://github.com/rayonlabs/G.O.D.git
//   - commit:       ebbd3d729c8c36173eac7022ff9aa29907d7f643 (tip of main,
//                   pushed_at 2026-09-07T20:48:06Z)
//   - env field names come straight from
//     `ops/tools/config/models.py::MinerConfig` (uppercased by
//     `create_config.py::write_config_to_file`) — NOT guessed:
//       WALLET_NAME, HOTKEY_NAME, SUBTENSOR_NETWORK, NETUID, REFRESH_NODES,
//       MIN_STAKE_THRESHOLD, ENV
//   - port: 7999 must be externally reachable — validators call
//     `GET http://<external_ip>:<external_port>/training_repo/{task_type}`
//     on it directly, so the machine needs a public port — a NAT'd laptop
//     can't serve it (see `requirements.publicEndpoint` below).
//   - enrollment: `fiber-post-ip` (a console script the image installs)
//     posts wallet+ip+port to the metagraph — that's the container's
//     `register` one-shot, run once in the same image before the long-lived
//     process starts.
//   - GPU floor: **G.O.D's miner process itself needs no GPU.** It's a
//     small FastAPI/uvicorn service that answers "here is my training
//     repo/commit" — validators run the actual training on their own
//     trainer infrastructure. No GPU floor is claimed here.
//
// Testnet is not wired: NETUID is hardcoded to 56 in the container env;
// SN56's documented testnet pairing is netuid 241 / `--subtensor.network
// test` — subtensorNetwork below only switches finney/test, not the netuid.
import type { SubnetMiner } from "@fezchat/extension-api";

const gradients: SubnetMiner = {
  netuid: 56,
  name: "gradients",
  // See "GPU floor" above — no GPU is required; the real gate is public
  // reachability (validators call this miner's endpoint directly).
  requirements: { alwaysOn: true, publicEndpoint: true },

  // No LLM provider/API key here — G.O.D's miner process answers
  // "here's my training repo", it never calls an inference API (see the
  // GPU-floor note above). What WAS hardcoded is the .1.env wizard's own
  // defaults and fiber-post-ip's --wallet.name — those are the real
  // per-persona knobs, so those are what's configurable.
  config: [
    { key: "walletName", label: "Bittensor wallet name", type: "string", default: "default", help: "coldkey wallet name on this machine (task miner-config's WALLET_NAME)" },
    { key: "subtensorNetwork", label: "Subtensor network", type: "select", options: ["finney", "test"], default: "finney", help: "NETUID stays 56 either way — testnet pairing (241) is not wired, see file header" },
    { key: "minStakeThreshold", label: "Min validator stake threshold", type: "number", default: 1000 },
    { key: "refreshNodes", label: "Refresh nodes", type: "boolean", default: true },
  ],

  container: {
    // Digest filled by the image-publish step below — a tag is not a pin.
    image: "ghcr.io/fezchat/gradients-miner@sha256:REPLACED_AT_PUBLISH",
    env: {
      WALLET_NAME: "{walletName}",
      HOTKEY_NAME: "{persona}",
      SUBTENSOR_NETWORK: "{subtensorNetwork}",
      NETUID: "56",
      REFRESH_NODES: "{refreshNodes}",
      MIN_STAKE_THRESHOLD: "{minStakeThreshold}",
    },
    ports: [{ internal: 7999 }],
    mountKeys: true,
    register: {
      command: [
        "fiber-post-ip", "--netuid", "56",
        "--subtensor.network", "{subtensorNetwork}",
        "--external_port", "{servePort}", "--external_ip", "{serveIp}",
        "--wallet.name", "{walletName}", "--wallet.hotkey", "{persona}",
      ],
    },
  },
};

export default [gradients];
