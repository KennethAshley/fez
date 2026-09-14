import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('native queue preserves message order and cancellation through repeated polling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fez-queue-eval-'));
  try {
    const binary = join(dir, 'queue-test');
    const source = fileURLToPath(new URL('../../fez-desktop/src-tauri/src/native_surface_queue.rs', import.meta.url));
    execFileSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { timeout: 30_000, stdio: 'pipe' });
    execFileSync(binary, [], { timeout: 15_000, stdio: 'pipe' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 45_000);
