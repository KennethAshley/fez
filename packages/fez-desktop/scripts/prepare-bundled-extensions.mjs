// Ship the same packages the installer consumes; no npm runs on the user's Mac.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(desktop, 'src-tauri/target/native-browser');
const output = join(cache, 'bundled-extensions');
await mkdir(cache, { recursive: true });
const stage = await mkdtemp(join(cache, 'extensions-'));
try {
  // FEZ_BUNDLED_EXTENSIONS lets the packaging test stage a subset: fez-workflows
  // builds against monorepo paths, which a copied-out package tree lacks.
  const names = process.env.FEZ_BUNDLED_EXTENSIONS?.split(',').filter(Boolean) ?? ['fez-browser', 'fez-browser-use', 'fez-workflows'];
  for (const name of names) {
    const cwd = resolve(desktop, '..', name);
    execFileSync('npm', ['run', 'build'], { cwd, stdio: 'inherit' });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage, '--cache', join(cache, 'npm-cache')], { cwd, encoding: 'utf8' }));
    console.log(`Bundled ${packed[0].id}`);
  }
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
} finally { await rm(stage, { recursive: true, force: true }); }
