import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('stops the browser and removes its profile when CDP close fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fez-cef-shutdown-'));
  await copyFile(new URL('../../fez-browser/prototype-cef/run.mjs', import.meta.url), join(dir, 'run.mjs'));
  await symlink(new URL('../../../node_modules', import.meta.url), join(dir, 'node_modules'));
  const executable = join(dir, 'fake-cef.mjs');
  await writeFile(executable, `#!${process.execPath}
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
const port = Number(process.argv.find(arg => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
writeFileSync(new URL('./cef.pid', import.meta.url), String(process.pid));
const server = createServer((_req, res) => res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port }])));
new WebSocketServer({ server }).on('connection', socket => socket.on('message', data => {
  const { id, method } = JSON.parse(String(data));
  socket.send(JSON.stringify({ id, ...(method === 'Browser.close' ? { error: { message: 'CDP close failed' } } : { result: {} }) }));
}));
server.listen(port, '127.0.0.1');
`, { mode: 0o755 });
  const runner = spawn(process.execPath, [join(dir, 'run.mjs')], {
    env: { ...process.env, FEZ_CEF_EXECUTABLE: executable, TMPDIR: dir }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(runner, 'exit');
  let errors = '';
  runner.stderr.on('data', data => { errors += String(data); });
  try {
    let session!: { endpoint: string; uiToken: string; profile: string };
    await vi.waitFor(async () => {
      expect(runner.exitCode, errors).toBeNull();
      session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
    }, { timeout: 5000 });
    const response = await fetch(`${session.endpoint}/control`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.uiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'stop' }), signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: 'stopped', epoch: 1 });
    await expect(access(session.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    const pid = Number(await readFile(join(dir, 'cef.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    runner.kill('SIGKILL');
    await exited;
    try { process.kill(Number(await readFile(join(dir, 'cef.pid'), 'utf8')), 'SIGKILL'); } catch { /* Already stopped. */ }
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
