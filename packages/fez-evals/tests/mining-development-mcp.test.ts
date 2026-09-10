import { expect,it } from 'vitest';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('chat reads masked setup and binds development operations to its own persona',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'development-mcp-'));const bin=join(dir,'mine');const calls=join(dir,'calls');
 writeFileSync(bin,`#!/usr/bin/env node
const a=process.argv.slice(2);require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');
if(a[0]==='describe')console.log(JSON.stringify({config:[{key:'key',type:'secret',label:'Key'},{key:'competition',type:'number',label:'Competition'}]}));
else if(a[0]==='config')console.log(JSON.stringify({key:'SHOULD-NEVER-LEAK',competition:27}));
else console.log(JSON.stringify({args:a}));`,{mode:0o700});
 const client=new Client({name:'development-check',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../fez-mining/dist/mcp.js',import.meta.url))],env:{PATH:process.env.PATH??'',FEZ_AGENT_PERSONA:'coder',FEZ_MINE_BIN:bin},stderr:'pipe'});
 try{
  await client.connect(transport);
  const setup=await client.callTool({name:'mining_setup',arguments:{netuid:62}});
  expect(JSON.stringify(setup)).not.toContain('SHOULD-NEVER-LEAK');
  expect(JSON.stringify(setup)).toContain('27');
  await client.callTool({name:'mining_workspace',arguments:{netuid:62,action:'configure',repository:'/repo',source:'agent.py',persona:'other'}});
  const last=readFileSync(calls,'utf8').trim().split('\n').map(s=>JSON.parse(s)).at(-1);
  expect(last).toEqual(['development','configure','--netuid','62','--persona','coder','--json','--repository','/repo','--source','agent.py']);
 }finally{await client.close();await transport.close();rmSync(dir,{recursive:true,force:true});}
});
