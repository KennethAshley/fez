import { expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, copyFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Opt-in native integration check: FEZ_CEF_EXECUTABLE must point to the CEF sample.
// Uses its own broker/profile; never takes over the user's open prototype session.
it.skipIf(!process.env.FEZ_CEF_EXECUTABLE)('maps a bounded agent screenshot to real CEF pointer targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fez-cef-pointer-eval-'));
  const source = new URL('../../fez-browser/prototype-cef/', import.meta.url);
  for (const file of await readdir(source)) {
    if (file.endsWith('.mjs')) await copyFile(new URL(file, source), join(dir, file));
  }
  await symlink(new URL('../../../node_modules', import.meta.url), join(dir, 'node_modules'));
  const runner = spawn(process.execPath, [join(dir, 'run.mjs')], { stdio: 'ignore' });
  const exited = once(runner, 'exit');
  const client = new Client({ name: 'cef-pointer-eval', version: '0' });
  let socket: WebSocket | undefined;
  try {
    let session: { endpoint: string; uiToken: string; pid: number } | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')); break; } catch {}
      if (runner.exitCode !== null) throw new Error('CEF runner exited before startup');
      await delay(100);
    }
    if (!session) throw new Error('CEF startup timed out');
    const { endpoint, uiToken, pid } = session;
    const owner = async (action: object) => {
      const response = await fetch(`${endpoint}/control`, { method: 'POST', headers: { Authorization: `Bearer ${uiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
      expect(response.status).toBe(200);
      return response.json();
    };
    // Read only this disposable child process's debug port, then inspect the fixture.
    const child = execFileSync('ps', ['-axo', 'ppid=,command='], { encoding: 'utf8' }).split('\n')
      .find(line => Number(line.trim().split(/\s+/)[0]) === pid);
    const port = child?.match(/--remote-debugging-port=(\d+)/)?.[1];
    expect(port).toBeDefined();
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find((t: { type: string }) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise<void>(resolve => socket!.addEventListener('open', () => resolve(), { once: true }));
    const pending = new Map<number, (value: { result: { value: unknown } }) => void>();
    let id = 0;
    socket.addEventListener('message', event => {
      const value = JSON.parse(String(event.data));
      pending.get(value.id)?.(value.result);
      pending.delete(value.id);
    });
    const evaluate = (expression: string) => new Promise<unknown>(resolve => {
      const call = ++id;
      pending.set(call, result => resolve(result.result.value));
      socket!.send(JSON.stringify({ id: call, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    await owner({ type: 'observe' });
    const geometry = await evaluate(`(() => {
      const center = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      return { width: innerWidth, height: innerHeight, input: center('input'), save: center('button') };
    })()`) as { width: number; height: number; input: { x: number; y: number }; save: { x: number; y: number } };
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dir, 'mcp.mjs')] }));
    const tool = (action: Record<string, unknown>) => client.callTool({ name: 'computer_use', arguments: action });
    await owner({ type: 'mode', value: 'agent' });
    expect((await tool({ type: 'click', x: 1, y: 1 })).isError).toBe(true);
    const observed = await tool({ type: 'observe' });
    const image = (observed.content as Array<{ type: string; data?: string }>).find(c => c.type === 'image');
    const bytes = Buffer.from(image!.data!, 'base64');
    let width = 0, height = 0;
    for (let offset = 2; offset + 9 < bytes.length;) {
      if ([0xc0, 0xc1, 0xc2].includes(bytes[offset + 1])) { width = bytes.readUInt16BE(offset + 7); height = bytes.readUInt16BE(offset + 5); break; }
      offset += bytes.readUInt16BE(offset + 2) + 2;
    }
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1024);
    const text = (observed.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text');
    expect(JSON.parse(text!.text!).screenshot).toEqual({ width, height });
    expect((await tool({ type: 'click', x: width, y: 1 })).isError).toBe(true);
    expect((await tool({ type: 'click', x: 1, y: -1 })).isError).toBe(true);
    for (const point of [geometry.input, geometry.save]) {
      expect((await tool({ type: 'click', x: point.x * width / geometry.width, y: point.y * height / geometry.height })).isError).not.toBe(true);
      if (point === geometry.input) await tool({ type: 'type', text: 'Pointer saved this' });
    }
    expect(await evaluate("document.querySelector('output').textContent")).toBe('Pointer saved this');
    await owner({ type: 'mode', value: 'human' });
    expect((await tool({ type: 'click', x: 1, y: 1 })).isError).toBe(true);
  } finally {
    await client.close();
    socket?.close();
    runner.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
