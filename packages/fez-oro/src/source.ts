import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const IMAGE = 'python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534';
export type Run = (args: string[], input?: Buffer) => Promise<string>;
const run: Run = (args, input) => new Promise((resolve, reject) => {
  const child = execFile('docker', args, { timeout: args[0] === 'rm' ? 5000 : 30000, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8' }, (err, stdout) => {
    if (err) reject(Error('ORO source check failed; check Python syntax, agent_main(problem_data), Docker and the pinned image.'));
    else resolve(stdout);
  });
  child.stdin?.on('error', () => {}); child.stdin?.end(input);
});

export async function source(file: string): Promise<Buffer> {
  if (!isAbsolute(file) || !file.endsWith('.py')) throw Error('Choose an absolute Python .py source file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw Error('Source must be a nonempty regular file of at most 1 MiB');
    const bytes = Buffer.alloc(1024 * 1024 + 1); let length = 0;
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, null);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (!length || length > 1024 * 1024) throw Error('Source must contain at most 1 MiB');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

// Parse and compile only. No candidate imports, decorators or code execute.
const CHECK = `import ast, sys
tree = ast.parse(sys.stdin.buffer.read(1048577))
compile(tree, 'agent.py', 'exec')
functions = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == 'agent_main']
assert len(functions) == 1 and isinstance(functions[0], ast.FunctionDef)
f = functions[0]
assert len(f.args.posonlyargs + f.args.args) == 1 and not f.args.vararg and not f.args.kwarg and not f.args.kwonlyargs and not f.decorator_list
print('source-contract-ok')
`;

export async function checkSource(bytes: Buffer, execute: Run = run): Promise<void> {
  const name = `fez-oro-check-${randomUUID()}`;
  try {
    const output = await execute(['run', '--rm', '--pull=never', '--name', name, '-i', '--network=none', '--read-only',
      '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=256m', '--memory-swap=256m',
      '--cpus=0.5', '--pids-limit=32', IMAGE, 'python', '-I', '-B', '-c', CHECK], bytes);
    if (output.trim() !== 'source-contract-ok') throw Error('Invalid ORO source-check response');
  } catch { throw Error('ORO source check failed; requires synchronous agent_main(problem_data), valid Python and the pinned Docker image.'); }
  finally { await execute(['rm', '-f', name]).catch(() => {}); }
}
