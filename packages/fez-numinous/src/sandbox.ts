import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const IMAGE = "python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534";
const MAX_SOURCE = 1024 * 1024;
const DOCKER_REQUIRED = "Docker required: install Docker and start its daemon to test candidates";
export type Exec = (file: string, args: string[], options: { input?: string; timeoutMs: number; maxBytes: number }) => Promise<{ code: number; stdout: string }>;

// No shell, inherited stderr, or error objects containing captured secret stdout.
export const run: Exec = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let size = 0;
  const fail = (missing = false) => {
    child.kill("SIGKILL");
    reject(new Error(missing && file === "docker" ? DOCKER_REQUIRED : "Numinous process failed or timed out"));
  };
  const timer = setTimeout(fail, options.timeoutMs);
  child.on("error", error => { clearTimeout(timer); fail("code" in error && error.code === "ENOENT"); });
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > options.maxBytes) fail();
    else chunks.push(chunk);
  });
  child.stdin.on("error", () => {}); // Early exit/EPIPE is reported by close.
  child.on("close", code => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") });
  });
  child.stdin.end(options.input);
});

export async function candidate(sourcePath: string): Promise<Buffer> {
  try {
    // Nonblocking open prevents a FIFO from hanging before the size check.
    const file = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SOURCE) throw new Error();
      const bytes: Buffer[] = [];
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
        size += chunk.length;
        if (size > MAX_SOURCE) throw new Error();
        bytes.push(chunk);
      }
      if (size === 0) throw new Error();
      return Buffer.concat(bytes);
    } finally { await file.close(); }
  } catch { throw new Error("Candidate must be a readable, nonempty regular file of at most 1 MiB"); }
}

const EVENT = {
  event_id: "fez-offline-check", title: "Synthetic interface test",
  description: "Not a real forecast or subnet submission.",
  cutoff: "2030-01-01T00:00:00Z", metadata: {}, memory: null,
};

// Runs ONLY inside Docker. Candidate stdout/stderr never becomes a user-facing log.
const WRAPPER = `import base64, contextlib, json, math, os, sys
request = json.load(sys.stdin)
event = request["event"]
namespace = {"__name__": "agent", "__file__": "/tmp/agent.py"}
try:
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        exec(compile(base64.b64decode(request["source"], validate=True), "agent.py", "exec"), namespace)
        output = namespace["agent_main"](event)
    if not isinstance(output, dict) or output.get("event_id") != event["event_id"]:
        raise ValueError()
    probability = output.get("prediction")
    if type(probability) not in (int, float) or not math.isfinite(probability) or not 0 <= probability <= 1:
        raise ValueError()
    memory = output.get("memory")
    if memory is not None and (not isinstance(memory, str) or len(memory) > 32768):
        raise ValueError()
    print(json.dumps({"event_id": event["event_id"], "prediction": probability, "memory": memory}, allow_nan=False))
except BaseException:
    print('{"error":"invalid candidate output"}')
    sys.exit(1)
`;

export async function sandbox(bytes: Buffer, exec: Exec): Promise<number> {
  const name = `fez-numinous-${randomUUID()}`;
  let result;
  try {
    result = await exec("docker", [
      "run", "--rm", "--pull=never", "--name", name, "-i",
      "--network=none", "--read-only", "--user=65534:65534",
      "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--pids-limit=32",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=8m", "--workdir=/tmp",
      IMAGE, "python", "-I", "-B", "-c", WRAPPER,
    ], { input: JSON.stringify({ source: bytes.toString("base64"), event: EVENT }), timeoutMs: 30000, maxBytes: 256 * 1024 });
  } catch (error) {
    if (error instanceof Error && error.message === DOCKER_REQUIRED) throw error;
    // eslint-disable-next-line preserve-caught-error -- A subprocess cause can contain candidate code or secrets.
    throw new Error("Numinous sandbox failed or timed out");
  } finally {
    // Killing the Docker client alone can leave the container running.
    await exec("docker", ["rm", "-f", name], { timeoutMs: 5000, maxBytes: 1024 }).catch(() => {});
  }
  if (result.code !== 0) throw new Error("Numinous sandbox failed; Docker, its daemon and the pinned Python image are required; candidate errors are suppressed");
  try {
    const value = JSON.parse(result.stdout);
    if (!value || value.event_id !== EVENT.event_id || typeof value.prediction !== "number" || !Number.isFinite(value.prediction) || value.prediction < 0 || value.prediction > 1 ||
      (value.memory != null && (typeof value.memory !== "string" || [...value.memory].length > 32768))) throw new Error();
    return value.prediction;
  } catch { throw new Error("Numinous sandbox returned an invalid prediction"); }
}
