import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { endpoint, uiToken } = JSON.parse(await readFile(new URL('./session.json', import.meta.url), 'utf8'));
const styles = await readFile(new URL('./gui.css', import.meta.url), 'utf8');
await build({ entryPoints: [new URL('./gui.ts', import.meta.url).pathname], outfile: new URL('./gui.js', import.meta.url).pathname,
  bundle: true, format: 'iife', globalName: '__fezExt', platform: 'browser', define: { SESSION: JSON.stringify({ endpoint, uiToken }), STYLES: JSON.stringify(styles) } });
// Link two independent development extensions; the agent tool never receives uiToken.
await build({ entryPoints: [new URL('../../fez-browser-use/src/mcp.ts', import.meta.url).pathname], outfile: new URL('./computer-use/mcp.js', import.meta.url).pathname,
  bundle: true, format: 'esm', platform: 'node', banner: { js: "import{createRequire as __require}from'node:module';const require=__require(import.meta.url);" } });
const computer = JSON.parse(await readFile(new URL('../../fez-browser-use/package.json', import.meta.url), 'utf8'));
await mkdir(new URL('./computer-use/', import.meta.url), { recursive: true });
await writeFile(new URL('./computer-use/package.json', import.meta.url), JSON.stringify({
  name: '@fezchat/computer-use-prototype', version: computer.version, private: true, type: 'module',
  description: computer.description,
  fez: { ...computer.fez, parts: { skill: { command: 'node', args: ['mcp.js'], env: { FEZ_BROWSER_USE_SESSION: new URL('./agent-session.json', import.meta.url).pathname } } } },
}, null, 2));
