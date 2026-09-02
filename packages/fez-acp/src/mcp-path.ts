/**
 * Where the fez-mcp tool server lives, and how to launch it — the pure
 * half, because getting it wrong is INVISIBLE: the agent boots, replies,
 * and simply has no fez_* tools while its prompt claims it does.
 *
 * Two compiled-binary traps stacked here (found live — every desktop
 * agent logged "⚠️ fez-mcp not built" while running fine otherwise):
 *
 *  1. The dev path resolves through import.meta.url, which inside a
 *     bun-compiled fez-agent points into bun's virtual filesystem —
 *     the path never exists on disk (same trap the bazaar validator
 *     documented for its fleet.json).
 *  2. The launch ran `process.execPath server.js` — fine in dev where
 *     execPath is bun/node, but in a compiled binary execPath is
 *     fez-agent ITSELF, which ignores script arguments and boots a
 *     second agent. So the compiled fallback is a SIBLING fez-mcp
 *     binary next to fez-agent in ~/.fez/bin, run directly.
 *
 * Dev wins when both exist: a source run should test source tools.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface McpLaunch {
  command: string;
  args: string[];
}

export function fezMcpLaunch(opts: {
  importMetaUrl: string;
  execPath: string;
  exists: (p: string) => boolean;
}): { launch?: McpLaunch; tried: string[] } {
  const dev = fileURLToPath(new URL("../../fez-mcp/dist/server.js", opts.importMetaUrl));
  const sibling = path.join(path.dirname(opts.execPath), "fez-mcp");
  const tried = [dev, sibling];
  if (opts.exists(dev)) return { launch: { command: opts.execPath, args: [dev] }, tried };
  if (opts.exists(sibling)) return { launch: { command: sibling, args: [] }, tried };
  return { tried };
}

/**
 * A skill entry's `command: node` is unrunnable exactly where agents
 * run: the desktop spawns them with the GUI's PATH (/usr/bin:/bin:…),
 * and a machine whose node lives in nvm has none there. The harness
 * spawns the tool server, the spawn dies, and the harness proceeds
 * WITHOUT the tool — invisible, the same class as the traps above
 * (found live: a persona said `mcpServers: [wallet]` while its agent
 * swore it had no wallet). Resolve bare "node" to a runtime that
 * actually exists: the managed runtime fez installs for the Claude
 * adapter (newest present version), then the standard install homes.
 * Pure for tests — home, exists and list come in.
 */
export function resolveNodeCommand(opts: {
  home: string;
  exists: (p: string) => boolean;
  list: (dir: string) => string[];
}): string | undefined {
  const root = path.join(opts.home, ".fez", "runtimes", "node");
  let versions: string[] = [];
  try {
    versions = opts.list(root).filter((v) => v.startsWith("v")).sort().reverse();
  } catch {
    /* no managed runtime dir — fall through to system homes */
  }
  for (const v of versions) {
    const candidate = path.join(root, v, "darwin-arm64", "bin", "node");
    if (opts.exists(candidate)) return candidate;
  }
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (opts.exists(candidate)) return candidate;
  }
  return undefined;
}
