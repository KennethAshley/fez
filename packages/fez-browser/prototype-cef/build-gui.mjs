import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const { endpoint, uiToken } = JSON.parse(await readFile(new URL('./session.json', import.meta.url), 'utf8'));
const styles = await readFile(new URL('./gui.css', import.meta.url), 'utf8');
await build({ entryPoints: [new URL('./gui.ts', import.meta.url).pathname], outfile: new URL('./gui.js', import.meta.url).pathname,
  bundle: true, format: 'iife', globalName: '__fezExt', platform: 'browser', define: { SESSION: JSON.stringify({ endpoint, uiToken }), STYLES: JSON.stringify(styles) } });
