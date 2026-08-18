import { Agent, type TaskPayload } from "@fez/protocol";
import { TaostatsClient } from "./taostats.js";
import { RepoInspector } from "./repo-inspector.js";
import { DockerMiner, type MinerConfig } from "./docker-miner.js";
import { WalletHelper, type WalletConfig } from "./wallet.js";

/**
 * Bittensor Taostats Agent — discovers subnets via taostats.io,
 * inspects their GitHub repos for miner code, and orchestrates
 * Docker containers to run miners.
 *
 * Task types:
 *   bittensor.list_subnets      — list all subnets with repo URLs
 *   bittensor.subnet_info       — detailed dev activity for a netuid
 *   bittensor.inspect_miner     — clone repo, find miner entry point
 *   bittensor.start_miner       — build Docker image, start miner container
 *   bittensor.stop_miner        — stop a running miner container
 *   bittensor.register_wallet   — get btcli registration commands
 *
 * Required env vars:
 *   FEZ_RELAY            — Nostr relay URL (default: wss://relay.damus.io)
 *   FEZ_PRIVATE_KEY      — Agent private key (auto-generated if unset)
 *   TAOSTATS_API_KEY     — taostats.io API key (tao-xxx:yyy format)
 *   BITTENSOR_WALLET_NAME — default wallet name (default: default)
 *   BITTENSOR_WALLET_HOTKEY — default hotkey name (default: default)
 */

const SUPPORTED_TASKS = [
  "bittensor.list_subnets",
  "bittensor.subnet_info",
  "bittensor.inspect_miner",
  "bittensor.start_miner",
  "bittensor.stop_miner",
  "bittensor.register_wallet",
];

async function main() {
  const relay = process.env.FEZ_RELAY || "wss://relay.damus.io";
  const apiKey = process.env.TAOSTATS_API_KEY;
  if (!apiKey) {
    console.error("❌ TAOSTATS_API_KEY is required");
    process.exit(1);
  }

  const taostats = new TaostatsClient(apiKey);
  const inspector = new RepoInspector();
  const docker = new DockerMiner();
  const wallet = new WalletHelper();

  const defaultWalletName = process.env.BITTENSOR_WALLET_NAME || "default";
  const defaultWalletHotkey = process.env.BITTENSOR_WALLET_HOTKEY || "default";

  const agent = await Agent.create({
    relay,
    name: "bittensor",
    supportedTasks: SUPPORTED_TASKS,
    metadata: {
      description: "Bittensor agent — discovers subnets via taostats.io and orchestrates Docker miners",
      dockerAvailable: docker.isAvailable(),
      btcliAvailable: wallet.isAvailable(),
    },
    privateKey: process.env.FEZ_PRIVATE_KEY,
  });

  agent.onTask(async (task: TaskPayload) => {
    const taskType = (task.content.params?.task_type as string) || task.content.instruction;
    const params = task.content.params || {};

    console.log(`📨 Received task: ${taskType}`, params);

    try {
      switch (taskType) {
        case "bittensor.list_subnets":
        case "list_subnets":
          await handleListSubnets(task, taostats);
          break;

        case "bittensor.subnet_info":
        case "subnet_info":
          await handleSubnetInfo(task, taostats, params);
          break;

        case "bittensor.inspect_miner":
        case "inspect_miner":
          await handleInspectMiner(task, taostats, inspector, params);
          break;

        case "bittensor.start_miner":
        case "start_miner":
          await handleStartMiner(task, taostats, inspector, docker, params, {
            walletName: defaultWalletName,
            walletHotkey: defaultWalletHotkey,
          });
          break;

        case "bittensor.stop_miner":
        case "stop_miner":
          await handleStopMiner(task, docker, params);
          break;

        case "bittensor.register_wallet":
        case "register_wallet":
          await handleRegisterWallet(task, wallet, params, {
            walletName: defaultWalletName,
            walletHotkey: defaultWalletHotkey,
          });
          break;

        default:
          await task.reply({
            status: "failure",
            error: {
              code: "UNSUPPORTED_TASK",
              message: `Unknown task type: ${taskType}. Supported: ${SUPPORTED_TASKS.join(", ")}`,
            },
          });
      }
    } catch (err) {
      console.error(`❌ Task failed:`, err);
      await task.reply({
        status: "failure",
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  await agent.start();

  console.log("Press Ctrl+C to stop");
  process.on("SIGINT", () => {
    agent.stop();
    process.exit(0);
  });
}

// ─── Task Handlers ─────────────────────────────────────────────────────────

async function handleListSubnets(task: TaskPayload, taostats: TaostatsClient) {
  await task.progress(10, "Querying taostats.io...");
  const subnets = await taostats.listSubnets();

  await task.reply({
    status: "success",
    result: {
      count: subnets.length,
      subnets: subnets.map((s) => ({
        netuid: s.netuid,
        repo_url: s.repo_url,
        as_of_day: s.as_of_day,
        last_event_at: s.last_event_at,
      })),
    },
  });
}

async function handleSubnetInfo(
  task: TaskPayload,
  taostats: TaostatsClient,
  params: Record<string, unknown>
) {
  const netuid = params.netuid as number;
  if (typeof netuid !== "number") {
    await task.reply({
      status: "failure",
      error: { code: "INVALID_INPUT", message: "netuid (number) is required" },
    });
    return;
  }

  await task.progress(20, `Fetching subnet ${netuid} info...`);
  const info = await taostats.getSubnetActivity(netuid);

  if (!info) {
    await task.reply({
      status: "failure",
      error: { code: "NOT_FOUND", message: `No data found for subnet ${netuid}` },
    });
    return;
  }

  await task.reply({
    status: "success",
    result: { ...info },
  });
}

async function handleInspectMiner(
  task: TaskPayload,
  taostats: TaostatsClient,
  inspector: RepoInspector,
  params: Record<string, unknown>
) {
  const netuid = params.netuid as number;
  if (typeof netuid !== "number") {
    await task.reply({
      status: "failure",
      error: { code: "INVALID_INPUT", message: "netuid (number) is required" },
    });
    return;
  }

  await task.progress(10, `Looking up subnet ${netuid}...`);
  const info = await taostats.getSubnetActivity(netuid);
  if (!info) {
    await task.reply({
      status: "failure",
      error: { code: "NOT_FOUND", message: `Subnet ${netuid} not found` },
    });
    return;
  }

  await task.progress(30, `Cloning ${info.repo_url}...`);
  const result = await inspector.inspect(info.repo_url);

  if (result.error) {
    await task.reply({
      status: "failure",
      error: { code: "DEPENDENCY_FAILURE", message: result.error },
    });
    return;
  }

  await task.progress(70, "Analyzing repo structure...");

  const miningInstructions = result.miner
    ? inspector.extractMiningInstructions(result.miner.readmeSnippet)
    : [];

  await task.reply({
    status: "success",
    result: {
      netuid,
      repo_url: result.repoUrl,
      local_path: result.localPath,
      miner_found: !!result.miner,
      miner: result.miner,
      all_candidates: result.allCandidates,
      mining_instructions: miningInstructions,
      docker_available: true,
      btcli_available: true,
    },
  });
}

async function handleStartMiner(
  task: TaskPayload,
  taostats: TaostatsClient,
  inspector: RepoInspector,
  docker: DockerMiner,
  params: Record<string, unknown>,
  defaults: { walletName: string; walletHotkey: string }
) {
  const netuid = params.netuid as number;
  const walletName = (params.wallet_name as string) || defaults.walletName;
  const walletHotkey = (params.wallet_hotkey as string) || defaults.walletHotkey;
  const useGpu = params.use_gpu as boolean | undefined;
  const axonPort = params.axon_port as number | undefined;

  if (typeof netuid !== "number") {
    await task.reply({
      status: "failure",
      error: { code: "INVALID_INPUT", message: "netuid (number) is required" },
    });
    return;
  }

  if (!docker.isAvailable()) {
    await task.reply({
      status: "failure",
      error: { code: "DEPENDENCY_FAILURE", message: "Docker is not available on this host" },
    });
    return;
  }

  // Step 1: Get subnet info
  await task.progress(5, `Looking up subnet ${netuid}...`);
  const info = await taostats.getSubnetActivity(netuid);
  if (!info) {
    await task.reply({
      status: "failure",
      error: { code: "NOT_FOUND", message: `Subnet ${netuid} not found` },
    });
    return;
  }

  // Step 2: Inspect repo
  await task.progress(15, `Cloning ${info.repo_url}...`);
  const inspectResult = await inspector.inspect(info.repo_url);
  if (inspectResult.error || !inspectResult.miner) {
    await task.reply({
      status: "failure",
      error: {
        code: "DEPENDENCY_FAILURE",
        message: inspectResult.error || "No miner entry point found in repo",
      },
    });
    return;
  }

  // Step 3: Build Docker image
  await task.progress(40, `Building Docker image for ${info.repo_url}...`);
  const minerConfig: MinerConfig = {
    netuid,
    walletName,
    walletHotkey,
    useGpu,
    axonPort,
  };

  const build = await docker.buildImage(inspectResult.localPath, inspectResult.miner, minerConfig);

  // Step 4: Start container
  await task.progress(80, "Starting miner container...");
  const run = docker.startMiner(build.imageName, minerConfig);

  await task.reply({
    status: "success",
    result: {
      netuid,
      repo_url: info.repo_url,
      image_name: build.imageName,
      container_id: run.containerId,
      container_name: run.containerName,
      docker_command: run.command,
      miner_script: inspectResult.miner.scriptPath,
      warning: "Ensure your wallet is registered on this subnet before mining. Use bittensor.register_wallet for btcli commands.",
    },
  });
}

async function handleStopMiner(
  task: TaskPayload,
  docker: DockerMiner,
  params: Record<string, unknown>
) {
  const containerId = params.container_id as string;
  const containerName = params.container_name as string;
  const target = containerId || containerName;

  if (!target) {
    await task.reply({
      status: "failure",
      error: { code: "INVALID_INPUT", message: "container_id or container_name is required" },
    });
    return;
  }

  docker.stopMiner(target);

  await task.reply({
    status: "success",
    result: { stopped: target },
  });
}

async function handleRegisterWallet(
  task: TaskPayload,
  wallet: WalletHelper,
  params: Record<string, unknown>,
  defaults: { walletName: string; walletHotkey: string }
) {
  const netuid = params.netuid as number;
  const walletName = (params.wallet_name as string) || defaults.walletName;
  const walletHotkey = (params.wallet_hotkey as string) || defaults.walletHotkey;
  const execute = params.execute as boolean | undefined;

  if (typeof netuid !== "number") {
    await task.reply({
      status: "failure",
      error: { code: "INVALID_INPUT", message: "netuid (number) is required" },
    });
    return;
  }

  const walletConfig: WalletConfig = { walletName, walletHotkey };
  const commands = wallet.generateRegistrationCommands(walletConfig, netuid);

  if (!execute) {
    await task.reply({
      status: "success",
      result: {
        netuid,
        wallet_name: walletName,
        wallet_hotkey: walletHotkey,
        commands,
        note: "Set execute=true to run these commands. Review them first — registration costs TAO.",
      },
    });
    return;
  }

  // Execute commands sequentially
  await task.progress(10, "Running registration commands...");
  const results: Array<{ command: string; stdout: string; stderr: string }> = [];

  for (const cmd of commands) {
    await task.progress(
      10 + (results.length / commands.length) * 80,
      `Running: ${cmd.description}`
    );
    const result = wallet.runCommand(cmd.command);
    results.push({ command: cmd.command, ...result });

    if (result.stderr) {
      await task.reply({
        status: "failure",
        error: {
          code: "DEPENDENCY_FAILURE",
          message: `Command failed: ${cmd.description}\n${result.stderr}`,
        },
      });
      return;
    }
  }

  // Verify registration
  const check = wallet.checkRegistration(walletConfig, netuid);

  await task.reply({
    status: check.registered ? "success" : "failure",
    result: {
      netuid,
      registered: check.registered,
      commands_run: results,
      registration_check: check,
    },
  });
}

main();
