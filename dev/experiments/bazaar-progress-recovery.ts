/** Read-only continuation probe using the actual old paid task and installed MCP. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "../../../fez-bazaar/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../../fez-bazaar/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { providerFor } from "../../../fez-bazaar/src/miner/provider.ts";

const root = path.resolve(import.meta.dir, "../..");
const prior = path.join(root,"docs/experiments/2026-09-09-bazaar-autonomous-hire");
const out = path.join(root,"docs/experiments/2026-09-09-bazaar-progress-recovery");
const ledgerPath = path.join(root,"docs/experiments/2026-09-09-bazaar-hiring-rerun/ledger.json");
const save = (name:string,value:unknown) => fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+"\n");
type Row = {id:string;type:string;reservedUsd:number;actualUsd?:number;[key:string]:unknown};
const loadLedger = ():Row[] => JSON.parse(fs.readFileSync(ledgerPath,"utf8"));
const writeLedger = (rows:Row[]) => fs.writeFileSync(ledgerPath,JSON.stringify(rows,null,2)+"\n");
const sum = (rows:Row[]) => rows.reduce((n,r) => n+(r.actualUsd??r.reservedUsd),0);
const taskId = "bc1c5dd3618c2a8fd6117a5f04c38f10cfcefd3ac0d88a4ac0bd513ad8066830";
assert(!fs.existsSync(path.join(out,"probe-start.json")) || process.argv.includes("--resume"),"Probe already attempted; use --resume to reuse saved model responses.");
if(!fs.existsSync(path.join(out,"probe-start.json"))) save("probe-start.json",{at:new Date().toISOString(),taskId,design:"Read-only continuation from the previous buyer's post-timeout state. Model chooses actions using the updated installed tool definitions. Actual relay history supplies any result. No wallet tools, payments or new tasks. This tests status retrieval and recovery judgment, not execution of a new paid hire.",model:"claude-haiku-4-5",modelCapUsd:0.25});
const client = new Client({name:"progress-recovery-probe",version:"1"});
const provider = providerFor("anthropic");
const history:unknown[] = [];
const actions:string[] = [];
try {
  await client.connect(new StdioClientTransport({command:"node",args:["/Users/ken/.fez/packages/bazaar/dist/bridge.js"],env:{PATH:process.env.PATH!,BAZAAR_RELAY:"wss://bazaar.fez.chat"},stderr:"pipe"}));
  const tools=(await client.listTools()).tools.filter(t => t.name === "bazaar_wait" || t.name === "market_directory");
  assert(tools.some(t => t.name === "bazaar_wait"));
  save("tools.json",tools);
  const state=JSON.parse(fs.readFileSync(path.join(prior,"history.json"),"utf8"));
  const cutoff=state.findIndex((r:{tool?:string}) => r.tool === "bazaar_ask");
  assert(cutoff>=0);
  const beforeFinish=state.slice(0,cutoff+1);
  const task=JSON.parse(fs.readFileSync(path.join(prior,"preregistered.json"),"utf8")).task;
  const system=`You are Drift, assessing how to recover the user's paid specialist review after a wait timed out. Resume the saved state below, which ends before the original buyer's final answer. Time has passed; no lease should be assumed active. This is a read-only probe: you may inspect existing work and the live directory, then choose what should happen next. Do not invent tool outcomes. Return JSON for one next action: {"tool":"bazaar_wait or market_directory or finish","arguments":{...},"reason":"brief action justification"}. On finish return arguments {"work_complete":boolean,"assessment":"what the evidence establishes","next_action":"concrete next step"}.\nTOOLS\n${JSON.stringify(tools)}`;
  save("context.json",{task,savedState:beforeFinish,system});
  for(let turn=0;turn<4;turn++) {
    const user=`TASK\n${task.task}\nSAVED POST-TIMEOUT STATE\n${JSON.stringify(beforeFinish)}\nCONTINUATION\n${JSON.stringify(history)}\nChoose the next action. Actions remaining: ${4-turn}.`;
    const rates=provider.price("claude-haiku-4-5");
    const reservedUsd=(Buffer.byteLength(system+user)+4096)*rates.input+1400*rates.output;
    const id=`autonomous-progress-recovery-${turn}`;
    const cached=path.join(out,`buyer-${turn}.json`);
    const result = fs.existsSync(cached) ? JSON.parse(fs.readFileSync(cached,"utf8")) : await (async () => {
    const rows=loadLedger();
    assert(!rows.some(r=>r.id===id));
    assert(sum(rows)+reservedUsd<=20);
    assert(sum(rows.filter(r=>r.id.startsWith("autonomous-")))+reservedUsd<=7);
    assert(sum(rows.filter(r=>r.id.startsWith("autonomous-progress-recovery-")))+reservedUsd<=0.25);
    writeLedger([...rows,{id,type:"model",reservedUsd,state:"reserved",at:new Date().toISOString()}]);
    const response=await provider.complete({model:"claude-haiku-4-5",system,user,maxTokens:1400});
    const actualUsd=response.inputTokens*rates.input+response.outputTokens*rates.output;
    save(`buyer-${turn}.json`,{...response,actualUsd,prompt:{system,user}});
    writeLedger(loadLedger().map(r=>r.id===id?{...r,actualUsd,state:response.stopReason==="end"?"completed":"incomplete"}:r));
    return {...response,actualUsd};
    })();
    const response=result;
    const actualUsd=result.actualUsd;
    assert(response.stopReason==="end"&&response.text.trim(),"incomplete model action; no paid retry");
    const action=JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/,"").replace(/\s*```$/,"")) as {tool:string;arguments:Record<string,unknown>;reason:string};
    history.push({action}); actions.push(action.tool);
    console.log(`${turn}: ${action.tool} — ${action.reason} ($${actualUsd.toFixed(5)})`);
    if(action.tool==="finish") { save("decision.json",{...action.arguments,actions}); break; }
    assert(action.tool==="bazaar_wait"||action.tool==="market_directory","only read-only tools are allowed");
    if(action.tool==="bazaar_wait") {
      assert.equal(action.arguments.task_id,taskId);
      assert(action.arguments.wait_s===undefined || (typeof action.arguments.wait_s==="number"&&Number.isInteger(action.arguments.wait_s)&&action.arguments.wait_s>=5&&action.arguments.wait_s<=180));
    }
    const toolResult=await client.callTool({name:action.tool,arguments:action.arguments},undefined,{timeout:210000});
    history.push({tool:action.tool,result:toolResult}); save("history.json",history);
  }
  save("history.json",history);
  assert(fs.existsSync(path.join(out,"decision.json")),"action budget exhausted before recovery decision");
} finally { await client.close(); }
