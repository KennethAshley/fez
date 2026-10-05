// Stable Tauri cannot package CEF. Keep the pinned compatibility toolchain local
// to this checkout and preserve the normal bundle paths used by release.sh.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const args = process.argv.slice(2);
const run = (command, argv, cwd = desktop, env = process.env) => execFileSync(command, argv, { cwd, env, stdio: 'inherit' });
if (args[0] !== 'build' || args.includes('--help') || args.includes('-h')) {
  run(join(desktop, 'node_modules/.bin/tauri'), args);
} else {
  // Only the CEF runtime below needs macOS. Everywhere else, build the
  // ordinary Tauri webview app with the stable CLI: no patched toolchain, no
  // staging step, and #[cfg(not(feature = "native-browser"))] takes the Tao
  // window path. Bundled extensions are skipped because only the native
  // browser build installs them at startup.
  if (process.platform !== 'darwin') {
    run(join(desktop, 'node_modules/.bin/tauri'), args);
    process.exit(0);
  }
  const target = resolve(desktop, process.env.CARGO_TARGET_DIR || 'src-tauri/target');
  const cache = join(desktop, 'src-tauri/target/native-browser');
  const pins = JSON.parse(await readFile(join(here, 'native-browser.json'), 'utf8'));
  const checkouts = {};
  for (const [name, pin] of Object.entries(pins)) {
    const override = process.env[name === 'tauri' ? 'FEZ_TAURI_CHECKOUT' : 'FEZ_TAURI_PLUGINS_CHECKOUT'];
    const path = resolve(override || join(cache, `${name}-${pin.revision}`));
    if (!override && !existsSync(join(path, '.git'))) {
      await mkdir(path, { recursive: true });
      run('git', ['init', path]);
      run('git', ['-C', path, 'fetch', '--depth=1', pin.url, pin.revision]);
      run('git', ['-C', path, 'checkout', '--detach', 'FETCH_HEAD']);
    }
    checkouts[name] = path;
  }
  run('npm', ['run', 'build']);
  run('npm', ['run', 'prepare-pi-agent']);
  run('npm', ['run', 'prepare-bundled-extensions']);
  // The stager verifies both revisions and rejects modified runtime sources.
  const stage = execFileSync(process.execPath, [resolve(desktop, '../fez-browser/prototype-tauri-cef/stage.mjs'),
    checkouts.tauri, checkouts.plugins, '--release'], { encoding: 'utf8' }).trim();
  try {
    run('cargo', ['build', '--locked', '-p', 'tauri-cli', '--manifest-path', join(checkouts.tauri, 'Cargo.toml'), '--target-dir', target]);
    await mkdir(target, { recursive: true });
    run(join(target, 'debug/cargo-tauri'), [...args, ...(args.includes('--') ? [] : ['--']), '--locked'], stage,
      { ...process.env, CARGO_TARGET_DIR: target });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
