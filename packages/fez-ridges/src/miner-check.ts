import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const IMAGE = "python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534";
export type Run = (args: string[], input?: string | Buffer) => Promise<string>;
const run: Run = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("docker", args, { timeout: args[0] === "rm" ? 5000 : 30000, killSignal: "SIGKILL", maxBuffer: 65536, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(new Error("Ridges source check failed: Docker, its daemon and the pinned Python image are required; source must export agent_main(input)."));
    else resolve(stdout);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
});

export async function source(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw Error("Agent must be a nonempty regular Python file of at most 1 MiB");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (!length || length > 1024 * 1024) throw Error("Agent source exceeds 1 MiB");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

// Parse only: no imports, decorators or candidate code execute, and no inference is billed.
const CHECK = `import ast, sys
source = sys.stdin.buffer.read(1048577)
tree = ast.parse(source)
compile(tree, 'agent.py', 'exec')
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'agent_main']
assert len(functions) == 1
f = functions[0]
assert len(f.args.posonlyargs + f.args.args) == 1 and not f.args.vararg and not f.args.kwarg and not f.args.kwonlyargs and not f.decorator_list
print('source-contract-ok')
`;

export async function checkSource(bytes: Buffer, execute: Run = run): Promise<void> {
  const name = `fez-ridges-${randomUUID()}`;
  try {
    const output = await execute([
      "run", "--rm", "--pull=never", "--name", name, "-i", "--network=none",
      "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--pids-limit=32",
      IMAGE, "python", "-I", "-B", "-c", CHECK,
    ], bytes);
    if (output.trim() !== "source-contract-ok") throw Error("Invalid Ridges source-check result");
  } finally { await execute(["rm", "-f", name]).catch(() => {}); }
}
