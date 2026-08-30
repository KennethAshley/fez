#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeX402Deps, x402FetchRaw, type X402ToolDeps } from "@fezchat/wallet";
import { dispatchRidges, type X402Call, type X402Outcome } from "./dispatch.js";
import { ridgesDir } from "./home.js";

/**
 * fez-ridges, skill part — the `ridges_dispatch` agent tool.
 *
 * Identity comes from FEZ_AGENT_PERSONA, same as every other skill in
 * this repo (fez-wallet, fez-kanban, fez-polls, …): this process pays
 * out of THIS persona's own wallet, never a name the tool call chooses.
 *
 * All money logic lives in the wallet: `makeX402Deps`/`x402FetchRaw` make
 * every cap/consent/offer decision before `dispatchRidges` ever sees an
 * outcome. This file only wires that up and turns the result into an
 * MCP tool reply.
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-ridges: FEZ_AGENT_PERSONA is not set — this skill only runs inside an agent harness.");
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = new McpServer({ name: "fez-ridges", version: "0.1.0" });

function asX402Call(): X402Call {
  return (deps, args) => x402FetchRaw(deps as X402ToolDeps, args) as Promise<X402Outcome>;
}

server.registerTool(
  "ridges_dispatch",
  {
    description:
      "Pay the Ridges subnet, through your own wallet, to work a GitHub issue — it opens a PR against it. " +
      "Refuses before any payment if the URL isn't a github.com issue link, or if the app isn't installed on that repo.",
    inputSchema: {
      issueUrl: z.string().describe("The GitHub issue URL, e.g. https://github.com/acme/widgets/issues/42."),
      maxUsd: z.number().optional().describe("The most you're willing to pay for this dispatch, in USD. Default: 5."),
    },
  },
  async ({ issueUrl, maxUsd }, extra) => {
    const x402Deps = await makeX402Deps(persona!, extra.signal);
    return text(
      await dispatchRidges({ persona: persona!, dir: ridgesDir(), x402: asX402Call(), x402Deps }, { issueUrl, maxUsd })
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
