// One compatibility stage for the shipping desktop and the isolated browser lab.
import { cp, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../../fez-desktop/src-tauri');
const [tauriArg, pluginsArg, mode] = process.argv.slice(2);
if (mode && !['--desktop', '--release'].includes(mode)) throw new Error('Unknown mode; use --desktop or --release');
const release = mode === '--release';
const fullDesktop = release || mode === '--desktop';
if (!tauriArg || !pluginsArg) throw new Error('Usage: node stage.mjs <tauri checkout> <plugins checkout> [--desktop|--release]');
const tauri = resolve(tauriArg);
const plugins = resolve(pluginsArg);
const pins = JSON.parse(await readFile(resolve(desktop, '../scripts/native-browser.json'), 'utf8'));
for (const [path, revision] of [
  [tauri, pins.tauri.revision],
  [plugins, pins.plugins.revision],
]) {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim() !== revision) {
    throw new Error(`Expected ${path} at ${revision}`);
  }
  const changes = execFileSync('git', ['diff', 'HEAD', '--', 'crates', 'plugins', 'Cargo.toml', 'Cargo.lock'], { cwd: path, encoding: 'utf8' });
  if (changes.trim()) throw new Error(`Runtime sources are modified: ${path}`);
}
const stage = await mkdtemp(join(tmpdir(), 'fez-tauri-cef-'));
const native = join(stage, 'src-tauri');
await mkdir(native);
const stagedPlugins = join(stage, 'plugins');
await mkdir(stagedPlugins);
let pluginWorkspace = await readFile(join(plugins, 'Cargo.toml'), 'utf8');
pluginWorkspace = pluginWorkspace.replace(/members = \[[\s\S]*?\]/, 'members = ["opener", "notification", "updater"]');
pluginWorkspace = pluginWorkspace.split('[patch.crates-io]')[0];
await writeFile(join(stagedPlugins, 'Cargo.toml'), pluginWorkspace);
for (const name of ['opener', 'notification', 'updater']) {
  await cp(join(plugins, 'plugins', name), join(stagedPlugins, name), { recursive: true });
  const path = join(stagedPlugins, name, 'Cargo.toml');
  // This branch retains obsolete mobile-only `tauri/wry` features. Cargo
  // validates those even for macOS; the new runtime lives in its own crate.
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll('tauri = { workspace = true, features = ["wry"] }', 'tauri = { workspace = true }'));
}
for (const name of ['src', 'icons', 'build.rs', 'capabilities']) await cp(join(desktop, name), join(native, name), { recursive: true });
await writeFile(join(native, 'capabilities/native-surface-owner.json'), JSON.stringify({ identifier: 'native-surface-owner', webviews: ['surface-owner-*'], permissions: ['core:event:allow-listen', 'core:event:allow-unlisten'] }));
// Lab-only lifecycle regression; these permissions do not change the real app.
if (!fullDesktop) {
  await writeFile(join(native, 'capabilities/native-surface-lab.json'), JSON.stringify({ identifier: 'native-surface-lab', webviews: ['main'], permissions: ['core:window:allow-minimize', 'core:window:allow-unminimize', 'core:window:allow-set-focus', 'core:window:allow-close'] }));
  await cp(join(here, 'host.rs'), join(native, 'src/browser_probe.rs'));
}
if (fullDesktop) {
  await cp(resolve(desktop, '../dist'), join(stage, 'ui'), { recursive: true });
  for (const file of ['owner.html', 'owner.js']) await cp(join(here, 'ui', file), join(stage, 'ui', file));
} else await cp(join(here, 'ui'), join(stage, 'ui'), { recursive: true });
if (!fullDesktop) await build({ entryPoints: [join(here, 'ui/main.ts')], outfile: join(stage, 'ui/main.js'), bundle: true, format: 'iife', platform: 'browser',
  define: { STYLES: JSON.stringify(await readFile(join(here, '../prototype-cef/gui.css'), 'utf8')) } });
const exact = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error(`Staging patch no longer matches: ${before}`);
  return source.replace(before, after);
};
let manifest = await readFile(join(desktop, 'Cargo.toml'), 'utf8');
manifest = exact(manifest, '[features]', '[features]\ndefault = ["native-browser"]');
for (const name of ['opener', 'notification', 'updater']) {
  manifest = exact(manifest, `tauri-plugin-${name} = "2"`, `tauri-plugin-${name} = { path = ${JSON.stringify(join(stagedPlugins, name))} }`);
}
// The custom CEF 152 prototype cannot share one process with upstream CEF 151.
manifest = exact(manifest, 'cef-prototype = ["dep:cef", "dep:objc2-app-kit", "dep:objc2-foundation"]', 'cef-prototype = []');
manifest = manifest.replace(/\[\[example\]\][\s\S]*?(?=\[dependencies\])/, '');
manifest = manifest.split('\n').filter(line => !/^(cef|objc2-app-kit|objc2-foundation) =/.test(line)).join('\n');
manifest = exact(manifest, '[dependencies]', `[dependencies]\ncef = "=151.8.1"\ngetrandom = "0.3"\nblock2 = "0.6"\nobjc2-app-kit = "0.3.2"\nobjc2-foundation = "0.3.2"\ntauri-runtime-cef = { path = ${JSON.stringify(join(tauri, 'crates/tauri-runtime-cef'))}, features = ["devtools", "unstable", "macos-private-api"] }`);
manifest += '\n[workspace]\n\n[patch.crates-io]\n';
for (const name of ['tauri', 'tauri-runtime', 'tauri-runtime-wry', 'tauri-build', 'tauri-macros', 'tauri-codegen', 'tauri-utils', 'tauri-plugin']) {
  manifest += `${name} = { path = ${JSON.stringify(join(tauri, 'crates', name))} }\n`;
}
manifest += 'dpi = { git = "https://github.com/tauri-apps/winit-gtk4", branch = "master" }\n';
await writeFile(join(native, 'Cargo.toml'), manifest);
await cp(resolve(desktop, '../scripts/native-browser.lock'), join(native, 'Cargo.lock'));
if (!fullDesktop) await writeFile(join(native, 'src/main.rs'), '#[tauri_runtime_cef::cef_entry_point]\nfn main() { fez_desktop_lib::browser_probe::run(); }\n');
if (!fullDesktop) await writeFile(join(native, 'src/lib.rs'), `${await readFile(join(native, 'src/lib.rs'), 'utf8')}\n// Staged entry point: never calls the identity/agent startup path.\npub mod browser_probe;\n`);
// Native surfaces share the existing host clipping logic.
const panel = join(native, 'src/isolated_panel.rs');
await writeFile(panel, exact(await readFile(panel, 'utf8'), '    fn rect<R: Runtime>', '    pub(crate) fn rect<R: Runtime>'));
await cp(resolve(desktop, '../../../src/agent/local-agents.json'), join(native, 'src/local-agents.json'));
const managed = join(native, 'src/managed_node.rs');
await writeFile(managed, exact(await readFile(managed, 'utf8'), '../../../../src/agent/local-agents.json', 'local-agents.json'));
const config = JSON.parse(await readFile(join(desktop, 'tauri.conf.json'), 'utf8'));
if (!release) {
  config.productName = fullDesktop ? 'Fez Native' : 'Fez Browser Lab';
  config.identifier = fullDesktop ? 'com.fez.native-dev' : 'com.fez.browser-lab';
  config.plugins = { updater: { pubkey: config.plugins.updater.pubkey, endpoints: [] } };
  config.bundle.targets = ['app'];
  config.bundle.createUpdaterArtifacts = false;
}
config.build = { frontendDist: '../ui' };
config.app.windows = [];
config.app.withGlobalTauri = true;
config.bundle.resources = {};
if (fullDesktop) {
  await cp(join(desktop, 'pi-agent'), join(native, 'pi-agent'), { recursive: true });
  await cp(join(desktop, 'target/native-browser/bundled-extensions'), join(native, 'bundled-extensions'), { recursive: true });
  config.bundle.resources = { 'pi-agent': 'pi-agent', 'bundled-extensions': 'bundled-extensions' };
}
config.bundle.cef = { embed: true };
await writeFile(join(native, 'tauri.conf.json'), JSON.stringify(config, null, 2));
console.log(stage);
