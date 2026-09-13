// Against the real CEF fixture: ownership, agent input, screenshot, stop, cleanup.
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const session = JSON.parse(await readFile(new URL('./session.json', import.meta.url), 'utf8'));
async function human(action) {
  const response = await fetch(`${session.endpoint}/control`, { method: 'POST', headers: { Authorization: `Bearer ${session.uiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
const client = new Client({ name: 'cef-probe-check', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('./mcp.mjs', import.meta.url).pathname] }));
const tool = action => client.callTool({ name: 'computer_use', arguments: action });
try {
  assert.equal((await fetch(`${session.endpoint}/control`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await tool({ type: 'type', text: 'not allowed' })).isError, true);
  await human({ type: 'mode', value: 'agent' });
  for (const action of [{ type: 'key', key: 'Tab' }, { type: 'type', text: 'Shared session works' }, { type: 'key', key: 'Tab' }, { type: 'key', key: 'Enter' }]) {
    assert.notEqual((await tool(action)).isError, true);
  }
  await delay(200);
  const observed = await tool({ type: 'observe' });
  assert.equal(observed.content[0].type, 'image');
  assert.ok(observed.content[0].data.length > 1000);
  const frame = await human({ type: 'observe' });
  assert.match(frame.text, /Shared session works/);
  await human({ type: 'mode', value: 'human' });
  assert.equal((await tool({ type: 'type', text: 'must be denied' })).isError, true);
  await human({ type: 'stop' });
  assert.equal((await tool({ type: 'observe' })).isError, true);
  await assert.rejects(access(session.profile));
  console.log('PASS: CEF screenshot, MCP typing/save, takeover denies agent, stop closes session and removes profile.');
} finally { await client.close(); }
