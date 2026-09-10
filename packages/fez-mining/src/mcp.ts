#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runMine, minersForPersona, mineArgs, classifyConfigKey } from "./mine-cli.js";
import type { ConfigField } from "@fezchat/extension-api";

/**
 * fez-mining, skill part — an MCP server that lets a running agent inspect
 * and (Task A2) direct ITS OWN miner. Same custody model as fez-polls: the
 * persona is fixed to FEZ_AGENT_PERSONA, so quill's tools act on quill's
 * miner and nothing else. No secret ever transits a tool call.
 */
const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-mining: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "fez-mining", version: "0.1.0" });

server.registerTool('mining_setup',{
  description:'Read THIS persona’s miner setup schema, non-secret values and secret presence. Use before helping configure or create a miner. Use mining_config for ordinary settings; direct the user to Mining setup for private credentials, never ask for keys in chat.',
  inputSchema:{netuid:z.number().int().nonnegative()},
},async({netuid})=>{
  const described=runMine(mineArgs.describe(netuid));
  if(described.code!==0)return text('Could not read miner setup; check that its extension is installed.');
  const descriptor=JSON.parse(described.stdout) as {config?:ConfigField[]};
  const configured=runMine(['config','get','--netuid',String(netuid),'--persona',persona,'--json']);
  const values=configured.code===0?JSON.parse(configured.stdout):{};
  return text(JSON.stringify({fields:(descriptor.config??[]).map(f=>({...f,value:f.type==='secret'?(values[f.key]==='set'?'set':'unset'):values[f.key]}))}));
});

server.registerTool('mining_workspace',{
  description:'Develop THIS persona’s custom miner. inspect reads linked repository/source, subnet instructions and experiment history. Use your coding/filesystem tools to create and commit the miner source according to those instructions. configure links an existing Git checkout and relative source file without executing it. evaluate starts a background evaluation and may incur inference costs: obtain user approval before calling it, then use inspect to follow its job status. Never retry while running. Compare runs only when evaluator/dataset/configuration match; a local score is not a guarantee of mining rewards. Never automatically submit, deploy, register or retry a failed evaluation.',
  inputSchema:{netuid:z.number().int().nonnegative(),action:z.enum(['inspect','configure','evaluate']),repository:z.string().optional(),source:z.string().optional()},
},async({netuid,action,repository,source})=>{
  const args=['development',action,'--netuid',String(netuid),'--persona',persona,'--json',...(repository?['--repository',repository]:[]),...(source?['--source',source]:[])];
  try {
    const {stdout}=await promisify(execFile)(process.env.FEZ_MINE_BIN||join(homedir(),'.fez','bin','fez-mine'),args,{encoding:'utf8',maxBuffer:4*1024*1024});
    return text(stdout);
  }catch{return text('Mining workspace command failed. Check the selected repository, source and evaluator setup in Mining; inspect experiment history before retrying a paid evaluation.');}
});

server.registerTool(
  "mining_status",
  {
    description:
      "Report THIS agent's own Bittensor miners. Process miners have running/stopped and machine state. For mode=submission, report submission.phase and versions: no local process is expected, so alive=false does not mean the submitted miner stopped. Use when asked how mining is going.",
    inputSchema: {},
  },
  async () => {
    const out = runMine(mineArgs.status());
    if (out.code !== 0) return text(`could not read mining status: ${out.stderr.trim()}`);
    const mine = minersForPersona(out.stdout, persona);
    if (mine.length === 0) return text(`${persona} has no recorded miners. For an existing uploaded miner, use mining_submission status to adopt it.`);
    return text(JSON.stringify(mine, null, 2));
  }
);

server.registerTool(
  "mining_metagraph",
  {
    description:
      "Live on-chain performance of THIS agent's miner on a subnet — incentive, emission, trust, rank, stake, immunity. Use when asked how a specific netuid is performing.",
    inputSchema: { netuid: z.number().int().describe("the subnet netuid") },
  },
  async ({ netuid }) => {
    const out = runMine(mineArgs.metagraph(persona, netuid));
    if (out.code !== 0) return text(`could not read metagraph for netuid ${netuid}: ${out.stderr.trim()}`);
    return text(out.stdout.trim() || "{}");
  }
);

server.registerTool(
  "mining_start",
  {
    description:
      "Start mining a Bittensor subnet as THIS agent. `machine: \"lium\"` rents a GPU pod (costs real money — the host will ask you to confirm); omit for a local miner. Requires any needed secret (e.g. the Lium key) to already be set in the mining cockpit.",
    inputSchema: {
      netuid: z.number().int().describe("the subnet to mine"),
      machine: z.enum(["local", "lium"]).optional().describe("where to run it (default local)"),
    },
  },
  async ({ netuid, machine }) => {
    const out = runMine(mineArgs.start(persona, netuid, machine));
    if (out.code !== 0) return text(`could not start netuid ${netuid}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`started mining netuid ${netuid}${machine === "lium" ? " on a Lium pod" : ""}. ${out.stdout.trim()}`);
  }
);

server.registerTool(
  "mining_stop",
  {
    description: "Stop THIS agent's miner on a subnet (tears down a rented pod if there is one).",
    inputSchema: { netuid: z.number().int().describe("the subnet to stop mining") },
  },
  async ({ netuid }) => {
    const out = runMine(mineArgs.stop(persona, netuid));
    if (out.code !== 0) return text(`could not stop netuid ${netuid}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`stopped mining netuid ${netuid}. ${out.stdout.trim()}`);
  }
);

server.registerTool(
  "mining_config",
  {
    description:
      "Set a NON-secret config parameter on THIS agent's miner (e.g. daily cap, model, submission name). Secrets are refused here. Changes apply on the next process restart or next code submission, depending on the descriptor. This tool never restarts or uploads.",
    inputSchema: {
      netuid: z.number().int().describe("the subnet"),
      key: z.string().describe("the config field to set"),
      value: z.string().describe("the new value"),
    },
  },
  async ({ netuid, key, value }) => {
    const desc = runMine(mineArgs.describe(netuid));
    if (desc.code !== 0) return text(`could not read netuid ${netuid} config schema: ${desc.stderr.trim()}`);
    let schema: ConfigField[] = [];
    let submission = false;
    try {
      const parsed = JSON.parse(desc.stdout);
      schema = parsed.config ?? [];
      submission = parsed.mode === "submission";
      if (!Array.isArray(schema)) schema = [];
    } catch { schema = []; }
    const verdict = classifyConfigKey(schema, key);
    if (verdict === "secret") return text(`"${key}" is a secret — set it in the mining cockpit, not chat.`);
    if (verdict === "unknown") {
      const settable = schema.filter((f) => f.type !== "secret").map((f) => f.key);
      return text(`netuid ${netuid} has no settable field "${key}". Settable: ${settable.join(", ") || "(none)"}.`);
    }
    const out = runMine(mineArgs.configSet(persona, netuid, key, value));
    if (out.code !== 0) return text(`could not set ${key}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`set ${key} = ${value} for netuid ${netuid}. ${submission ? "This applies to the next code submission; the uploaded version is unchanged." : "This applies on the next restart — ask before restarting the miner."}`);
  }
);

server.registerTool("mining_submission", {
  description: "Manage THIS agent's validator-hosted submission. status adopts/refreshes existing uploaded versions without uploading; register explicitly enrolls and may burn test tokens. test checks local Python source in keyless networkless Docker and returns its SHA256; read detail for check coverage (Ridges checks syntax only). submit uploads only those checked bytes and requires that SHA256. Ask the user before registration or any submission: Ridges consumes a funded ticket, shares configured OpenRouter runtime/management keys with Ridges, and bills screening inference. Never automatically retry an uncertain upload. Activation is not proof of execution or rewards. No container start/stop or provider linking.",
  inputSchema: {
    netuid:z.number().int().nonnegative(),
    action:z.enum(["status","register","test","submit"]),
    file:z.string().optional().describe("Absolute local Python source file for test/submit"),
    sha256:z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Exact hash returned by a successful test; required to submit"),
  },
}, async ({netuid,action,file,sha256}) => {
  if ((action === "test" || action === "submit") && !file) return {...text("file is required"),isError:true};
  if (action === "submit" && !sha256) return {...text("Test the file first and pass its sha256"),isError:true};
  const out=runMine(mineArgs.submission(persona,netuid,action,file,sha256));
  return out.code === 0 ? text(out.stdout.trim()) : {...text(out.stderr.trim() || "Submission operation failed"),isError:true};
});

const transport = new StdioServerTransport();
await server.connect(transport);
