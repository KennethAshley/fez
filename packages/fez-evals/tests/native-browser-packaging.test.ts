import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);

it.skipIf(process.platform !== 'darwin')('stages the normal Fez identity, updates, signed resources and owner assets without lab permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fez-native-package-'));
  let stage: string | undefined;
  const desktop = join(root, 'packages/fez-desktop/src-tauri');
  const probe = join(root, 'packages/fez-browser/prototype-tauri-cef');
  const tauri = join(root, 'tauri checkout');
  const plugins = join(root, 'plugins checkout');
  const bin = join(root, 'bin');
  const put = async (path: string, data: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); };
  try {
    await symlink(new URL('../../../node_modules/', import.meta.url), join(root, 'node_modules'));
    await mkdir(probe, { recursive: true });
    await mkdir(desktop, { recursive: true });
    await copyFile(new URL('../../fez-browser/prototype-tauri-cef/stage.mjs', import.meta.url), join(probe, 'stage.mjs'));
    await mkdir(join(desktop, '../scripts'), { recursive: true });
    for (const file of ['native-browser.json', 'native-browser.lock']) {
      await copyFile(new URL(`../../fez-desktop/scripts/${file}`, import.meta.url), join(desktop, '../scripts', file));
    }
    for (const file of ['Cargo.toml', 'tauri.conf.json']) {
      await copyFile(new URL(`../../fez-desktop/src-tauri/${file}`, import.meta.url), join(desktop, file));
    }
    const config = JSON.parse(await readFile(join(desktop, 'tauri.conf.json'), 'utf8'));
    await put(join(desktop, 'src/lib.rs'), '// real desktop entry point\n');
    await put(join(desktop, 'src/isolated_panel.rs'), '    fn rect<R: Runtime>() {}');
    await put(join(desktop, 'src/managed_node.rs'), 'include_str!("../../../../src/agent/local-agents.json");');
    await put(join(root, 'src/agent/local-agents.json'), '[]');
    await put(join(desktop, 'icons/icon.icns'), 'icon');
    await put(join(desktop, 'capabilities/default.json'), '{"webviews":["main"]}');
    await put(join(desktop, 'build.rs'), 'fn main() {}');
    await put(join(desktop, 'pi-agent/fez-agent'), 'signed-agent-fixture');
    await put(join(desktop, 'target/native-browser/bundled-extensions/browser.tgz'), 'extension-archive-fixture');
    await put(join(desktop, '../dist/index.html'), '<main>Fez</main>');
    await put(join(probe, 'ui/owner.html'), '<main>Browser control</main>');
    await put(join(probe, 'ui/owner.js'), '// owner control');
    await put(join(probe, 'host.rs'), '// lab entry point');
    await put(join(tauri, 'Cargo.lock'), '# upstream lock fixture\n');
    await put(join(plugins, 'Cargo.toml'), '[workspace]\nmembers = ["plugins/opener"]\n[patch.crates-io]\n');
    for (const name of ['opener', 'notification', 'updater']) {
      await put(join(plugins, 'plugins', name, 'Cargo.toml'), '[dependencies]\ntauri = { workspace = true, features = ["wry"] }\n');
    }
    // Git is the only external boundary: no network or native compiler in this packaging check.
    await put(join(bin, 'git'), `#!/usr/bin/env node\nif(process.argv[2]==='rev-parse') console.log(process.cwd().endsWith('tauri checkout')?'c8c75b1f7f43e7cb1e7d773ed2f6f96fad2fe975':'1423992771e0b57582ca3b06a6adc46ec26aa784');\n`);
    await chmod(join(bin, 'git'), 0o755);
    stage = (await run(process.execPath, [join(probe, 'stage.mjs'), tauri, plugins, '--release'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })).stdout.trim();
    const native = join(stage, 'src-tauri');
    const result = JSON.parse(await readFile(join(native, 'tauri.conf.json'), 'utf8'));
    expect(result).toMatchObject({ productName: 'fez', identifier: 'com.fez.desktop', plugins: config.plugins,
      build: { frontendDist: '../ui' }, app: { windows: [] },
      bundle: { createUpdaterArtifacts: true, resources: { 'pi-agent': 'pi-agent' }, targets: 'all' } });
    expect(result.build.beforeBuildCommand).toBeUndefined();
    expect(await readFile(join(native, 'pi-agent/fez-agent'), 'utf8')).toBe('signed-agent-fixture');
    expect(await readFile(join(native, 'bundled-extensions/browser.tgz'), 'utf8')).toBe('extension-archive-fixture');
    expect(await readFile(join(stage, 'ui/index.html'), 'utf8')).toBe('<main>Fez</main>');
    expect(await readFile(join(stage, 'ui/owner.html'), 'utf8')).toBe('<main>Browser control</main>');
    expect(JSON.parse(await readFile(join(native, 'capabilities/native-surface-owner.json'), 'utf8'))).toMatchObject({
      webviews: ['surface-owner-*'], permissions: ['core:event:allow-listen', 'core:event:allow-unlisten'],
    });
    await expect(readFile(join(native, 'capabilities/native-surface-lab.json'))).rejects.toThrow();
    await expect(readFile(join(native, 'src/browser_probe.rs'))).rejects.toThrow();
    expect(await readFile(join(native, 'src/lib.rs'), 'utf8')).toBe('// real desktop entry point\n');
    expect(await readFile(join(native, 'Cargo.lock'), 'utf8')).toBe(await readFile(new URL('../../fez-desktop/scripts/native-browser.lock', import.meta.url), 'utf8'));
    // Exercise the normal command with the actual stager. Only npm/cargo are replaced:
    // compiling CEF would turn a packaging regression check into a multi-minute native build.
    await copyFile(new URL('../../fez-desktop/scripts/tauri-native.mjs', import.meta.url), join(desktop, '../scripts/tauri-native.mjs'));
    await put(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'npm'), 0o755);
    await put(join(bin, 'cargo'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(!args.includes('--locked')) process.exit(12);
if(fs.realpathSync(args[args.indexOf('--target-dir')+1])!==fs.realpathSync(${JSON.stringify(join(desktop, 'target'))})) process.exit(14);
const cli=path.join(args[args.indexOf('--target-dir')+1],'debug/cargo-tauri');
fs.mkdirSync(path.dirname(cli),{recursive:true});
fs.writeFileSync(cli,${JSON.stringify(`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
if(!process.argv.includes('--locked')) process.exit(13);
const result={args:process.argv.slice(2),config:JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'))};
fs.writeFileSync(path.join(process.env.CARGO_TARGET_DIR,'packaged.json'),JSON.stringify(result));
`)});
fs.chmodSync(cli,0o755);
`);
    await chmod(join(bin, 'cargo'), 0o755);
    const built = await run(process.execPath, [join(desktop, '../scripts/tauri-native.mjs'), 'build', '--debug', '--bundles', 'app'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FEZ_TAURI_CHECKOUT: tauri, FEZ_TAURI_PLUGINS_CHECKOUT: plugins, CARGO_TARGET_DIR: '' },
    }).then(() => ({ error: undefined }), error => ({ error: String(error) }));
    expect(built.error).toBeUndefined();
    const packaged = JSON.parse(await readFile(join(desktop, 'target/packaged.json'), 'utf8'));
    expect(packaged).toMatchObject({ args: ['build', '--debug', '--bundles', 'app', '--', '--locked'],
      config: { productName: 'fez', identifier: 'com.fez.desktop', bundle: { cef: { embed: true }, createUpdaterArtifacts: true } } });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (stage) await rm(stage, { recursive: true, force: true });
  }
});

it('packages independently runnable Browser and Browser Use extensions without runtime npm dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fez-bundled-extensions-'));
  const scripts = join(root, 'packages/fez-desktop/scripts');
  try {
    await mkdir(scripts, { recursive: true });
    await symlink(new URL('../../../node_modules/', import.meta.url), join(root, 'node_modules'));
    await copyFile(new URL('../../fez-desktop/scripts/prepare-bundled-extensions.mjs', import.meta.url), join(scripts, 'prepare-bundled-extensions.mjs'));
    for (const name of ['fez-browser', 'fez-browser-use']) {
      const target = join(root, 'packages', name);
      await mkdir(target, { recursive: true });
      for (const file of ['package.json', 'README.md', 'src', 'tsconfig.json']) {
        await cp(new URL(`../../${name}/${file}`, import.meta.url), join(target, file), { recursive: true });
      }
    }
    await copyFile(new URL('../../fez-browser/tsconfig.types.json', import.meta.url), join(root, 'packages/fez-browser/tsconfig.types.json'));
    await mkdir(join(root, 'packages/fez-browser/prototype-cef'));
    await copyFile(new URL('../../fez-browser/prototype-cef/gui.css', import.meta.url), join(root, 'packages/fez-browser/prototype-cef/gui.css'));
    // Only the two browser packages are staged here; fez-workflows (also bundled) builds against monorepo paths.
    const result = await run(process.execPath, [join(scripts, 'prepare-bundled-extensions.mjs')], { env: { ...process.env, FEZ_BUNDLED_EXTENSIONS: 'fez-browser,fez-browser-use' } })
      .then(() => ({ error: undefined }), error => ({ error: String(error) }));
    expect(result.error).toBeUndefined();
    const output = join(root, 'packages/fez-desktop/src-tauri/target/native-browser/bundled-extensions');
    const archives = (await readdir(output)).filter(file => file.endsWith('.tgz'));
    expect(archives).toHaveLength(2);
    const tools = new Map<string, string[]>();
    for (const [index, file] of archives.entries()) {
      const unpacked = join(root, `unpacked-${index}`); await mkdir(unpacked);
      await run('tar', ['-xzf', join(output, file), '-C', unpacked]);
      const pkg = join(unpacked, 'package');
      const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
      const skill = manifest.fez.parts.skill;
      const client = new Client({ name: 'bundled-package-test', version: '1' });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(pkg, skill.args[0])],
          env: { ...skill.env, CAMOFOX_BASE_URL: 'http://127.0.0.1:1', FEZ_BROWSER_USE_SESSION: join(root, 'missing-session.json') } }));
        tools.set(manifest.name, (await client.listTools()).tools.map(tool => tool.name));
      } finally { await client.close(); }
      if (manifest.name === '@fezchat/browser-use') {
        const session = join(root, 'session.json');
        await writeFile(session, JSON.stringify({ version: 2, targets: [] }));
        for (const variable of ['FEZ_BROWSER_USE_SESSION', 'FEZ_COMPUTER_USE_SESSION']) {
          const legacyClient = new Client({ name: 'browser-use-env-test', version: '1' });
          try {
            await legacyClient.connect(new StdioClientTransport({ command: process.execPath, args: [join(pkg, skill.args[0])],
              env: { ...skill.env, [variable]: session } }));
            expect(await legacyClient.callTool({ name: 'browser_use', arguments: { type: 'list' } }))
              .toMatchObject({ content: [{ type: 'text', text: '{"targets":[]}' }] });
          } finally { await legacyClient.close(); }
        }
      }
      if (manifest.fez.parts.gui) {
        expect(runInNewContext(`${await readFile(join(pkg, manifest.fez.parts.gui), 'utf8')}; typeof __fezExt.activate`)).toBe('function');
      }
    }
    expect(tools.get('@fezchat/browser')).toEqual(['browser_open', 'browser_read', 'browser_close']);
    expect(tools.get('@fezchat/browser-use')).toEqual(['browser_use']);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);

it('refuses a signed release before building when notarization or updater credentials are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fez-signing-preflight-'));
  try {
    const security = join(root, 'security');
    await writeFile(security, '#!/bin/sh\nexit 1\n');
    await chmod(security, 0o755);
    await copyFile(new URL('../../fez-desktop/scripts/build-signed.sh', import.meta.url), join(root, 'build-signed.sh'));
    await writeFile(join(root, 'prepare-pi-agent.mjs'), 'throw new Error("Build must not start");');
    const result = await run('bash', [join(root, 'build-signed.sh')], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, APPLE_SIGNING_IDENTITY: 'test-identity',
        APPLE_ID: '', APPLE_PASSWORD: '', APPLE_TEAM_ID: '', TAURI_SIGNING_PRIVATE_KEY: '' },
    }).then(() => ({ stderr: '', stdout: '' }), error => error as { stderr: string; stdout: string });
    expect(result.stderr + result.stdout).toContain('Missing release credentials: APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID TAURI_SIGNING_PRIVATE_KEY');
    expect(result.stderr + result.stdout).not.toContain('preparing bundled agent');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps signed bundled binaries intact when a forced rebuild reaches the second preparation hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fez-signed-resources-'));
  const scripts = join(root, 'scripts'); const bin = join(root, 'fake-tools');
  try {
    await mkdir(scripts); await mkdir(bin);
    await copyFile(new URL('../../fez-desktop/scripts/build-signed.sh', import.meta.url), join(scripts, 'build-signed.sh'));
    await writeFile(join(scripts, 'prepare-pi-agent.mjs'), `import fs from 'node:fs';
const path=${JSON.stringify(join(root, 'src-tauri/pi-agent/fez-agent'))};
fs.mkdirSync(${JSON.stringify(join(root, 'src-tauri/pi-agent'))},{recursive:true});
if(process.env.FORCE || !fs.existsSync(path)) fs.writeFileSync(path,'unsigned');
`);
    const commands: Record<string, string> = {
      file: 'console.log("Mach-O executable");',
      codesign: 'if(!process.argv.includes("--verify")) require("node:fs").writeFileSync(process.argv.at(-1),"signed");',
      spctl: '', xcrun: 'console.log("validated");',
      npm: `const fs=require('node:fs'),path=require('node:path');
require('node:child_process').execFileSync(process.execPath,['scripts/prepare-pi-agent.mjs']);
const bundle=path.join(process.cwd(),'src-tauri/target/release/bundle');
fs.mkdirSync(path.join(bundle,'macos/fez.app'),{recursive:true});
fs.mkdirSync(path.join(bundle,'dmg'),{recursive:true});
fs.writeFileSync(path.join(bundle,'dmg/fez.dmg'),'disk image');
fs.copyFileSync('src-tauri/pi-agent/fez-agent',path.join(bundle,'macos/fez.app/fez-agent'));
`,
    };
    for (const [name, script] of Object.entries(commands)) {
      await writeFile(join(bin, name), `#!/usr/bin/env node\n${script}\n`); await chmod(join(bin, name), 0o755);
    }
    await run('bash', [join(scripts, 'build-signed.sh')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      APPLE_SIGNING_IDENTITY: 'fixture', APPLE_ID: 'fixture', APPLE_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture', TAURI_SIGNING_PRIVATE_KEY: 'fixture', FORCE: '1', FORCE_ALL: '1' } });
    expect(await readFile(join(root, 'src-tauri/target/release/bundle/macos/fez.app/fez-agent'), 'utf8')).toBe('signed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
