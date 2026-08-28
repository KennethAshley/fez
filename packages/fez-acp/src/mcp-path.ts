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
