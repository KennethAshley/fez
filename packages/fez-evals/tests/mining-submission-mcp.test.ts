import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

it("chat submission controls bind the caller persona and require a tested hash before dispatch", async () => {
  const dir=mkdtempSync(join(tmpdir(),'submission-mcp-'));
  const bin=join(dir,'mine'); const calls=join(dir,'calls');
  writeFileSync(bin,`#!/usr/bin/env node\nconst a=process.argv.slice(2);require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');console.log(JSON.stringify({args:a}));`,{mode:0o700});
  const client=new Client({name:'submission-eval',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../fez-mining/dist/mcp.js',import.meta.url))],
    env:{PATH:process.env.PATH ?? '',FEZ_AGENT_PERSONA:'drift',FEZ_MINE_BIN:bin},stderr:'pipe'});
  try {
    await client.connect(transport);
    const tool=(await client.listTools()).tools.find(t=>t.name==='mining_submission')!;
    expect(tool.inputSchema.properties).not.toHaveProperty('persona');
    await client.callTool({name:'mining_submission',arguments:{action:'status',netuid:155,persona:'quill'}});
    expect(JSON.parse(readFileSync(calls,'utf8'))).toEqual(['submission','status','--netuid','155','--persona','drift','--json']);
    const before=readFileSync(calls,'utf8');
    const result=await client.callTool({name:'mining_submission',arguments:{action:'submit',netuid:155,file:'/tmp/agent.py'}});
    expect(result.isError).toBe(true);
    expect(readFileSync(calls,'utf8')).toBe(before);
  } finally {
    await client.close();
    await transport.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
