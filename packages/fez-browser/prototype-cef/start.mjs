// Run from this checkout; installs only this development extension, never Camofox.
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const root = new URL('../../../', import.meta.url).pathname;
const runner = spawn(process.execPath, [new URL('./run.mjs', import.meta.url).pathname], { stdio: 'inherit' });
process.once('SIGINT', () => runner.kill('SIGINT'));
process.once('SIGTERM', () => runner.kill('SIGTERM'));
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { ready = JSON.parse(await readFile(new URL('./session.json', import.meta.url), 'utf8')).pid === runner.pid; } catch {}
    if (ready) break;
    if (runner.exitCode !== null) throw new Error('CEF startup failed');
    await delay(200);
  }
  if (!ready) throw new Error('CEF startup timed out');
  execFileSync(process.execPath, [new URL('./build-gui.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  execFileSync(process.execPath, [new URL('../../../dist/cli.js', import.meta.url).pathname, 'link', new URL('.', import.meta.url).pathname, '--no-build'], { stdio: 'inherit', cwd: root });
  console.log('Restart Fez when safe, then enter /cef in a chat. Ctrl+C ends the temporary browser session.');
} catch (error) { runner.kill('SIGTERM'); throw error; }
