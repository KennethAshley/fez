import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolContext } from '../../fez-acp/src/tool-context.js';

it('publishes effective tools and ends a failed turn without leaking prompt content', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fez-tool-context-'));
  const context = new ToolContext(home, 'quill', ['browser-use']);
  const file = join(home, '.fez', 'agent-runtime', 'quill.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  try {
    expect(read()).toMatchObject({ version: 1, persona: 'quill', tools: ['browser-use'], turn: null });
    await expect(context.run({ id: 'a'.repeat(64), order: ['quill', 'drift'] }, async () => {
      expect(read().turn).toEqual({ id: 'a'.repeat(64), order: ['quill', 'drift'], state: 'running' });
      throw new Error('cancelled');
    })).rejects.toThrow('cancelled');
    expect(read().turn.state).toBe('done');
    expect(Object.keys(read()).sort()).toEqual(['persona', 'pid', 'tools', 'turn', 'updatedAt', 'version']);
    context.close();
    expect(existsSync(file)).toBe(false);
  } finally { context.close(); rmSync(home, { recursive: true, force: true }); }
});
