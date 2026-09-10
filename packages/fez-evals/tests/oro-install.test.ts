import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CATALOG } from '../../fez-desktop/src/extensions-catalog.js';

it('ships a standalone miner bundle that Mining can discover without npm at runtime', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const home = await mkdtemp(join(tmpdir(), 'fez-oro-install-'));
  try {
    const manifest = JSON.parse(await readFile(join(root, 'packages/fez-oro/package.json'), 'utf8'));
    expect(CATALOG.find(entry => entry.name === manifest.name)?.permissions).toEqual(manifest.fez.permissions);
    expect(manifest.fez.parts).toEqual({ miner: 'dist/miner.js' });
    await mkdir(join(home, 'miners'));
    await writeFile(join(home, 'package.json'), '{"type":"module"}');
    const bundle = join(home, 'miners/oro.js');
    execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'packages/fez-oro/src/miner.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`], { stdio: 'pipe' });
    const script = `import {pathToFileURL} from 'node:url';const {default: miners}=await import(pathToFileURL(process.argv[1]));const m=miners[0];console.log(JSON.stringify({count:miners.length,netuid:m.netuid,network:m.network,name:m.name,submission:['status','test','submit'].every(k=>typeof m.submission[k]==='function'),evaluate:typeof m.development.evaluate,process:!!(m.start||m.container),secrets:m.config.filter(f=>f.type==='secret').map(f=>f.key)}));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, bundle], { encoding: 'utf8', timeout: 15000 }));
    expect(result).toMatchObject({ count: 1, netuid: 15, network: 'finney', name: 'ORO', submission: true, evaluate: 'function', process: false });
    expect(result.secrets).toEqual(expect.arrayContaining(['openrouter_api_key', 'chutes_api_key']));
    const description = JSON.parse(execFileSync(process.execPath, [join(root, 'packages/fez-mining/dist/cli.js'), 'describe', '--netuid', '15', '--json'], { env: { ...process.env, FEZ_MINE_HOME: home }, encoding: 'utf8', timeout: 15000 }));
    expect(description).toMatchObject({ name: 'ORO', netuid: 15 });
    expect(description.config.find((field: {key: string}) => field.key === 'openrouter_api_key').type).toBe('secret');
  } finally { await rm(home, { recursive: true, force: true }); }
});
