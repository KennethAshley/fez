/**
 * Fez TUI extension for Bittensor Taostats.
 *
 * Loaded by loadExtensions() from ~/.fez/extensions/. This file is
 * bundled to a single .js file — no node_modules imports allowed.
 *
 * Provides:
 *   - /bittensor command — list subnets, inspect, start/stop miners
 *   - Sidebar panel showing discovered subnets
 *   - Integration with the standalone agent via subprocess
 */

import type { FezExtensionAPI, PanelHandle } from "@fez/protocol";

// ─── Inline minimal dependencies (bundle script resolves these) ────────────

interface SubnetInfo {
  netuid: number;
  repo_url: string;
  as_of_day: string;
  last_event_at: string;
  days_since_last_event?: number;
  commits_30d?: number;
  unique_contributors_30d?: number;
}

interface MinerStatus {
  containerId: string;
  containerName: string;
  netuid: number;
  status: "running" | "stopped";
  startedAt: string;
}

// ─── Extension state ────────────────────────────────────────────────────────

let panel: PanelHandle | null = null;
let subnets: SubnetInfo[] = [];
const miners: MinerStatus[] = [];
let api: FezExtensionAPI;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getApiKey(): string {
  return process.env.TAOSTATS_API_KEY || "";
}

async function fetchSubnets(): Promise<SubnetInfo[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    api.ui.notify("⚠️  TAOSTATS_API_KEY not set");
    return [];
  }

  const url = "https://api.taostats.io/api/dev_activity/latest/v1?per_page=50";
  const res = await fetch(url, {
    headers: { Authorization: apiKey, Accept: "application/json" },
  });

  if (!res.ok) {
    api.ui.notify(`❌ taostats API error: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { data: Array<Record<string, unknown>> };
  return data.data.map((d) => ({
    netuid: d.netuid as number,
    repo_url: d.repo_url as string,
    as_of_day: d.as_of_day as string,
    last_event_at: d.last_event_at as string,
    days_since_last_event: d.days_since_last_event as number | undefined,
    commits_30d: d.commits_30d as number | undefined,
    unique_contributors_30d: d.unique_contributors_30d as number | undefined,
  }));
}

function renderPanel() {
  if (!panel) return;

  const lines: string[] = [
    "Bittensor Subnets",
    "─────────────────",
    "",
  ];

  if (subnets.length === 0) {
    lines.push("No subnets loaded.", "", "Run /bittensor list to fetch.");
  } else {
    for (const s of subnets.slice(0, 20)) {
      const active = s.days_since_last_event === 0 ? "🟢" : "⚪";
      lines.push(`${active} SN${String(s.netuid).padEnd(4)} ${s.repo_url.slice(0, 40)}`);
      if (s.commits_30d !== undefined) {
        lines.push(`     ${s.commits_30d} commits (30d), ${s.unique_contributors_30d ?? "?"} contributors`);
      }
    }
    if (subnets.length > 20) {
      lines.push(`", ... and ${subnets.length - 20} more`);
    }
  }

  if (miners.length > 0) {
    lines.push("", "Running Miners", "──────────────");
    for (const m of miners) {
      lines.push(`⛏️  SN${m.netuid} ${m.containerName} (${m.status})`);
    }
  }

  panel.setText(lines.join("\n"));
}

// ─── Command handler ─────────────────────────────────────────────────────────

async function handleBittensorCommand(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] || "help";

  switch (subcommand) {
    case "list":
    case "ls": {
      api.ui.notify("Fetching subnets from taostats.io...");
      subnets = await fetchSubnets();
      renderPanel();
      api.ui.notify(`✅ Loaded ${subnets.length} subnets`);
      break;
    }

    case "info": {
      const netuid = parseInt(parts[1], 10);
      if (isNaN(netuid)) {
        api.ui.notify("Usage: /bittensor info <netuid>");
        return;
      }
      const subnet = subnets.find((s) => s.netuid === netuid);
      if (!subnet) {
        api.ui.notify(`Subnet ${netuid} not found. Run /bittensor list first.`);
        return;
      }
      api.ui.appendMessage(
        "bittensor",
        `Subnet ${netuid}\nRepo: ${subnet.repo_url}\nLast event: ${subnet.last_event_at}\n30d commits: ${subnet.commits_30d ?? "?"}\n30d contributors: ${subnet.unique_contributors_30d ?? "?"}`,
        Date.now()
      );
      break;
    }

    case "mine": {
      const netuid = parseInt(parts[1], 10);
      if (isNaN(netuid)) {
        api.ui.notify("Usage: /bittensor mine <netuid>");
        return;
      }
      api.ui.notify(
        `To mine subnet ${netuid}, run the standalone agent:\n` +
        `  cd packages/bittensor && node dist/agent.js\n` +
        `Then send it a bittensor.start_miner task.`
      );
      break;
    }

    case "help":
    default: {
      api.ui.appendMessage(
        "bittensor",
        [
          "Bittensor Commands",
          "",
          "/bittensor list          — fetch all subnets from taostats",
          "/bittensor info <netuid> — show subnet details",
          "/bittensor mine <netuid> — how to start mining this subnet",
          "/bittensor help          — show this help",
          "",
          "For actual mining, run the standalone agent:",
          "  cd packages/bittensor && node dist/agent.js",
        ].join("\n"),
        Date.now()
      );
      break;
    }
  }
}

// ─── Extension entry point ───────────────────────────────────────────────────

const extension: (api: FezExtensionAPI) => void = (extensionApi) => {
  api = extensionApi;

  // Create sidebar panel
  panel = api.ui.createSidePanel({
    title: "Bittensor",
    icon: "⛏️",
    width: 40,
    order: 50,
  });
  renderPanel();

  // Register command
  api.registerCommand("bittensor", async (args) => {
    await handleBittensorCommand(args);
  });

  // URL handler for repo links
  api.registerUrlHandler("https://github.com/", (url) => {
    api.ui.notify(`Open in browser: ${url}`);
  });

  api.ui.notify("⛏️  Bittensor extension loaded. /bittensor help for commands.");
};

export default extension;
