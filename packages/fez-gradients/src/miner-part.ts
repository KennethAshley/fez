import type { SubnetMiner } from "@fezchat/extension-api";
import { image } from "./image.js";

// Gradients' serving process needs a public CPU host; validators supply GPUs.
// Testnet pairing verified against G.O.D docs/miner.md, 2026-09-09.
// Network is fixed here, not editable config: 56 is a different chain entry.
const gradients: SubnetMiner = {
  netuid: 241,
  network: "test",
  name: "gradients (testnet)",
  requirements: { alwaysOn: true, publicEndpoint: true },
  config: [
    { key: "tournamentType", label: "Tournament type", type: "select", options: ["text", "image", "environment"], default: "text", required: true },
    { key: "trainingRepo", label: "Public training repository", type: "string", required: true,
      pattern: "https://github\\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+",
      help: "Public GitHub repository containing the tournament Dockerfile, LICENSE and NOTICE. Only this tournament type will be offered." },
    { key: "trainingCommit", label: "Training commit (40-character SHA)", type: "string", required: true, pattern: "[a-fA-F0-9]{40}",
      help: "Exact commit validators will train and evaluate. A branch name is not accepted." },
    { key: "minStakeThreshold", label: "Min validator stake threshold", type: "number", default: 1000,
      help: "Fiber's request filter, not a stake you must deposit. Set to match the testnet validator." },
    { key: "refreshNodes", label: "Refresh nodes", type: "boolean", default: true },
  ],
  container: {
    image,
    env: {
      // deployHotkey writes /root/.bittensor/wallets/default/hotkeys/<persona>.
      WALLET_NAME: "default", HOTKEY_NAME: "{persona}",
      SUBTENSOR_NETWORK: "test", NETUID: "241",
      REFRESH_NODES: "{refreshNodes}", MIN_STAKE_THRESHOLD: "{minStakeThreshold}",
      GRADIENTS_TOURNAMENT_TYPE: "{tournamentType}",
      GRADIENTS_TRAINING_REPO: "{trainingRepo}", GRADIENTS_TRAINING_COMMIT: "{trainingCommit}",
    },
    ports: [{ internal: 7999 }],
    mountKeys: true,
    register: {
      command: [
        "fiber-post-ip", "--netuid", "241", "--subtensor.network", "test",
        "--external_port", "{servePort}", "--external_ip", "{serveIp}",
        "--wallet.name", "default", "--wallet.hotkey", "{persona}",
      ],
    },
  },
};
export default [gradients];
