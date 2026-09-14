import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Execute the real producer and both consumers; a source-only import check missed the old path bug.
it('builds independently runnable browser-use and compatibility entrypoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fez-computer-package-'));
  const probe = join(root, 'packages/fez-browser/prototype-cef');
  await mkdir(probe, { recursive: true });
  await symlink(new URL('../../../node_modules/', import.meta.url), join(root, 'node_modules'));
  const computer = join(root, 'packages/fez-browser-use');
  await mkdir(computer);
  await copyFile(new URL('../../fez-browser-use/package.json', import.meta.url), join(computer, 'package.json'));
  // A newly pulled package has source but no dist; startup must produce everything the shim uses.
  await cp(new URL('../../fez-browser-use/src/', import.meta.url), join(computer, 'src'), { recursive: true });
  for (const file of ['build-gui.mjs', 'gui.ts', 'gui.css', 'mcp.mjs']) {
    await copyFile(new URL(`../../fez-browser/prototype-cef/${file}`, import.meta.url), join(probe, file));
  }
  await mkdir(join(probe, '../src'));
  await copyFile(new URL('../../fez-browser/src/native-gui.ts', import.meta.url), join(probe, '../src/native-gui.ts'));
  // Building UI needs only owner connection data. It must not require a browser download/session.
  await writeFile(join(probe, 'session.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:1', uiToken: 'test-owner' }));
  try {
    await promisify(execFile)(process.execPath, [join(probe, 'build-gui.mjs')]);
    const manifest = JSON.parse(await readFile(join(probe, 'computer-use/package.json'), 'utf8'));
    const skill = manifest.fez.parts.skill as { args: string[]; env: Record<string, string> };
    for (const args of [skill.args.map(arg => join(probe, 'computer-use', arg)), [join(probe, 'mcp.mjs')]]) {
      const client = new Client({ name: 'computer-package-eval', version: '1' });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args, env: skill.env }));
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['browser_use']);
        const result = await client.callTool({ name: 'browser_use', arguments: { type: 'observe' } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('Connect a surface');
      } finally { await client.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
