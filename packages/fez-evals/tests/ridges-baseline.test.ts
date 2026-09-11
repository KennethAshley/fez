import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks the local coding baseline budget and file-edit boundaries without inference', () => {
  const test = fileURLToPath(new URL('../../../examples/ridges-local-baseline/test_agent.py', import.meta.url));
  expect(() => execFileSync('python3', ['-B', test], { timeout: 10000, stdio: 'pipe' })).not.toThrow();
});
