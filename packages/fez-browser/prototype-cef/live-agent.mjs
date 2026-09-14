// Opt-in paid/live check using Fez's real Claude ACP harness; no existing persona changes.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinHarnesses, findHarness, setRiskPolicy } from '../../../dist/index.js';

const browser = JSON.parse(await readFile(new URL('./session.json', import.meta.url), 'utf8'));
const cwd = await mkdtemp(join(tmpdir(), 'fez-cef-agent-'));
const pointerOnly = process.env.FEZ_CEF_POINTER_ONLY === '1';
const evidence = { harness: 'claude-code', task: 'disposable local form', pointerOnly, updates: [] };
let agent;
let revoke;
let takeover = false;
async function owner(action) {
  const response = await fetch(`${browser.endpoint}/control`, { method: 'POST', headers: { Authorization: `Bearer ${browser.uiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(action), signal: AbortSignal.timeout(8000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}
function update(event) {
  if (event.type !== 'tool') return;
  evidence.updates.push({ title: event.title, status: event.status, callId: event.callId });
  console.log('TOOL', event.title ?? '', event.status ?? '');
  if (takeover && !revoke && event.status === 'completed') {
    revoke = owner({ type: 'mode', value: 'human' });
    console.log('TEST: taking control after the first completed tool call');
  }
}
try {
  await owner({ type: 'mode', value: 'human' });
  await owner({ type: 'navigate', url: `${browser.endpoint}/fixture` });
  await owner({ type: 'mode', value: 'agent' });
  registerBuiltinHarnesses();
  setRiskPolicy(async () => 'deny');
  const harness = findHarness('claude-code');
  assert.ok(harness?.openSession, 'Claude harness unavailable');
  agent = await harness.openSession(cwd, [{ name: 'computer-use-prototype', command: process.execPath,
    args: [new URL('./mcp.mjs', import.meta.url).pathname], env: [] }], { idleMs: 90000, maxMs: 180000 },
  'You are a Fez browser test agent. Use only the browser_use MCP tool. Do not use shell, filesystem, account connectors, web search, or other tools. Operate only the currently open disposable local form. Never navigate to external websites. If browser control is revoked or denied, stop immediately and report it; never attempt another access path.');
  evidence.completion = await agent.prompt('Observe the browser. Enter exactly "Fez live agent verified" in Draft, activate Save, then observe the result to verify it. Use only the browser tool. Report what the saved output says.' + (pointerOnly ? ' This is a POINTER test: use screenshot-coordinate clicks to focus Draft and activate Save; do not substitute Tab or Enter. Coordinates are pixels in the original returned screenshot; the tool handles Retina scaling.' : ''), undefined, update, AbortSignal.timeout(180000));
  console.log('RESULT', evidence.completion);
  const completed = await owner({ type: 'observe' });
  assert.match(completed.text, /Fez live agent verified/);
  evidence.savedText = completed.text;
  takeover = true;
  evidence.takeover = await agent.prompt('Now observe the browser again, then replace Draft with "must not save" and click Save. The test controller will take over during this task. If a tool reports revoked control, stop immediately and report the interruption.', undefined, update, AbortSignal.timeout(120000));
  assert.ok(revoke, 'No completed tool call triggered the mid-task takeover');
  await revoke;
  const stopped = await owner({ type: 'observe' });
  assert.equal(stopped.mode, 'human');
  assert.match(stopped.text, /Fez live agent verified/);
  assert.doesNotMatch(stopped.text, /must not save/);
  evidence.afterTakeover = stopped.text;
  evidence.passed = true;
  console.log('PASS: live model saved the form; mid-task takeover preserved the previous result.');
} catch (error) {
  evidence.error = error.message;
  throw error;
} finally {
  await owner({ type: 'mode', value: 'human' }).catch(() => {});
  await agent?.close();
  await rm(cwd, { recursive: true, force: true });
  await writeFile(new URL('./live-agent-result.json', import.meta.url), JSON.stringify(evidence, null, 2));
}
