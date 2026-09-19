#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { getPublicKey } from "nostr-tools/pure";
import { getKey, loadOrCreateKey } from "../../../src/identity/keys.js";
import { fezHome } from "../../../src/shared/fez-home.js";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { startMeshGateway, gatewayReady, workspaceAccess } from "./mesh.js";
import { startProvider, updateMember, checkProvider, type ProviderOptions } from "./provider.js";
import { configureClient, validateGateway, sshArguments, machineLabel, DEFAULT_LABEL, type GatewayConfig } from "./config.js";
import { enrollCaller, revokeCaller, resolveCallerToken, listCallers, publicCallers, validatePersona, withCallerLock, MODEL_PROVIDER } from "./enrollment.js";

const exec = promisify(execFile);
interface HostConfig extends ProviderOptions { role: "host"; modelCommand: { file: string; args: string[] } }
type Config = GatewayConfig | HostConfig;
const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string" }, file: { type: "string" }, name: { type: "string" }, json: { type: "boolean" } } });
const command = positionals[0];
const configFile = resolve(values.config ?? fezHome("mesh", "mini", "config.json"));
const entry = fileURLToPath(import.meta.url);
const label = (kind: string) => `chat.fez.mesh.mini.${kind}`;
const domain = () => `gui/${process.getuid!()}`;
process.umask(0o077);

function secret(name: string) {
  const key = getKey(name);
  if (!key) throw new Error(`Identity ${name} is missing; initialize it explicitly`);
  return Buffer.from(key, "hex");
}
async function remote(config: GatewayConfig, action: string, argument?: string) {
  const args = sshArguments(config);
  if (argument && !/^[a-f0-9]{64}$/.test(argument)) throw new Error("Invalid public key");
  return exec("/usr/bin/ssh", [...args, config.ssh,
    `${config.remoteNode} ${config.remoteCli} ${action} --config ${config.remoteConfig}${argument ? " " + argument : ""}`], { timeout: 90000 });
}
async function installServices(config: Config) {
  const directory = dirname(configFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (config.role === "gateway") {
    await configureClient(config, homedir());
    loadOrCreateKey(`agent:${config.persona}`);
  }
  const jobs = config.role === "host" ? [
    { kind: "model", args: [config.modelCommand.file, ...config.modelCommand.args] },
    { kind: "host", args: [process.execPath, entry, "serve", "--config", configFile] },
  ] : [{ kind: "gateway", args: [process.execPath, entry, "serve", "--config", configFile] }];
  for (const job of jobs) {
    const path = join(directory, `${job.kind}.plist`);
    const jsonPath = `${path}.json`;
    await writeFile(jsonPath, JSON.stringify({ Label: label(job.kind), ProgramArguments: job.args,
      KeepAlive: true, ThrottleInterval: 5, ExitTimeOut: 5, ProcessType: job.kind === "model" ? "Interactive" : "Background",
      WorkingDirectory: directory, StandardOutPath: join(directory, `${job.kind}.log`),
      StandardErrorPath: join(directory, `${job.kind}.log`),
      EnvironmentVariables: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homedir() },
    }), { mode: 0o600 });
    try { await exec("/usr/bin/plutil", ["-convert", "xml1", "-o", path, jsonPath]); }
    finally { await rm(jsonPath, { force: true }); }
  }
  console.log("Service definitions saved. Run fez-mesh start to load them.");
}
async function service(config: Config, start: boolean) {
  if (start && config.role === "gateway") await remote(config, "start");
  const kinds = config.role === "host" ? (start ? ["model", "host"] : ["host", "model"]) : ["gateway"];
  for (const kind of kinds) {
    const target = `${domain()}/${label(kind)}`;
    const loaded = await exec("/bin/launchctl", ["print", target]).then(() => true, () => false);
    if (start && !loaded) await exec("/bin/launchctl", ["bootstrap", domain(), join(dirname(configFile), `${kind}.plist`)]);
    if (!start && loaded) await exec("/bin/launchctl", ["bootout", target]);
  }
  if (!start && config.role === "gateway") await remote(config, "stop");
  console.log(start ? "Services started; use fez-mesh status to check readiness." : "Services stopped.");
}
async function readiness(config: Config) {
  if (config.role === "host") {
    await checkProvider(config);
  } else {
    await remote(config, "status");
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/models`, {
      headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Signed model access unavailable (${response.status})`);
    const result = await response.json() as { data?: { id: string }[] };
    if (!result.data?.some(model => model.id === config.model)) throw new Error("Mesh model does not match the persona");
  }
}
async function status(config: Config) {
  await readiness(config);
  console.log(`READY: ${config.model}${config.role === "gateway" ? ` on ${config.ssh}, persona ${config.persona}` : " loaded"}`);
}
async function serve(config: Config) {
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  if (config.role === "host") {
    const host = await startProvider(config);
    console.log(`Provider listening at ${host.url}`);
    try { await stopped; } finally { await host.close(); }
    return;
  }
  const tunnel = spawn("/usr/bin/ssh", [...sshArguments(config), "-T",
    "-L", `127.0.0.1:${config.hostPort}:127.0.0.1:${config.hostPort}`,
    "-L", `127.0.0.1:${config.relayPort}:127.0.0.1:${config.relayPort}`,
    config.ssh, 'printf "MESH_READY\\n"; exec cat'], { stdio: ["pipe", "pipe", "inherit"] });
  const ended = new Promise<never>((_resolve, reject) => {
    tunnel.once("error", reject);
    tunnel.once("exit", (code, signal) => reject(new Error(`SSH disconnected (${code ?? signal}); launchd will reconnect`)));
  });
  void ended.catch(() => {});
  const lines = createInterface({ input: tunnel.stdout });
  const ready = new Promise<void>(resolve => { lines.on("line", line => { if (line === "MESH_READY") resolve(); }); });
  let gateway: Awaited<ReturnType<typeof startMeshGateway>> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const starting = Promise.race([ready, ended, stopped.then(() => { throw new Error("Stopped while connecting"); }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("SSH readiness timed out")), 15000); })]);
    await starting; clearTimeout(timeout);
    gateway = await startMeshGateway({ host: `http://127.0.0.1:${config.hostPort}`, port: config.port,
      secretKey: secret(`agent:${config.persona}`), token: config.token, timeoutMs: 125000,
      resolveCaller: authorization => resolveCallerToken({ home: homedir(), authorization, loadKey: getKey }) });
    console.log(`Gateway ready at ${gateway.url}; transport ${config.ssh}`);
    // An interrupted completion is never replayed; launchd reconnects for the next request.
    await Promise.race([stopped, ended]);
  } finally {
    clearTimeout(timeout); lines.close();
    await gateway?.close(); tunnel.stdin.end(); tunnel.kill("SIGTERM");
  }
}
async function ask(config: GatewayConfig) {
  if (!values.file) throw new Error("Use fez-mesh ask --file /absolute/path/to/task.txt");
  await status(config);
  const prompt = await readFile(values.file, "utf8");
  if (!prompt.trim() || Buffer.byteLength(prompt) > 64000) throw new Error("Task must contain 1–64000 bytes");
  const directory = await mkdtemp(join(tmpdir(), "fez-mesh-task-"));
  try {
    const request = join(directory, "request.json");
    await writeFile(request, JSON.stringify({ prompt, maxCostUsd: 1, timeoutMs: 120000 }), { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dirname(entry), "evaluate.mjs")], { stdio: ["ignore", "inherit", "inherit"], timeout: 135000,
        cwd: directory, env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
          FEZ_AGENT_PERSONA: config.persona, FEZ_EVALUATION_REQUEST: request,
          FEZ_RELAY: `ws://127.0.0.1:${config.relayPort}`, PI_OFFLINE: "1", PI_TELEMETRY: "0",
          PI_CODING_AGENT_DIR: fezHome("mesh", "mini", "pi") } });
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Fez evaluation exited ${code}`)));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function main() {
  if (command === "identity") {
    if (!values.name || !/^agent:[a-z][a-z0-9-]{0,40}$/.test(values.name)) throw new Error("Use --name agent:<name>");
    console.log(`IDENTITY=${getPublicKey(Buffer.from(loadOrCreateKey(values.name), "hex"))}`); return;
  }
  if (!command || command === "help") {
    console.log("fez-mesh install-services | start | stop | status | state --json | connect --name PERSONA | disconnect --name PERSONA | ask --file task.txt | admit PUBKEY | revoke PUBKEY [--config path]"); return;
  }
  let rawConfig: string;
  try { rawConfig = await readFile(configFile, "utf8"); }
  catch (error) {
    if (command === "state" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(JSON.stringify({ configured: false, provider: MODEL_PROVIDER, model: "", label: DEFAULT_LABEL, machine: "",
        status: "offline", detail: "Mini has not been configured", callersVerified: false, callers: [] })); return;
    }
    throw error;
  }
  let config: Config;
  try { config = JSON.parse(rawConfig) as Config; }
  catch { throw new Error("Invalid Mini configuration JSON"); }
  if (config.role === "gateway") validateGateway(config);
  else if (config.role !== "host" || !/^[a-f0-9]{64}$/.test(config.owner)) throw new Error("Invalid provider profile");
  if (command === "state") {
    if (config.role !== "gateway") throw new Error("State is available on the caller Mac");
    let ready = true;
    try {
      await remote(config, "status"); // Mini verifies model, signed host and pinned workspace owner.
      if (!await gatewayReady(`http://127.0.0.1:${config.port}`)) ready = false;
    } catch { ready = false; }
    let callers = await listCallers(homedir());
    let callersVerified = false;
    const wire = new RelayConnection({ url: `ws://127.0.0.1:${config.relayPort}` });
    try {
      await wire.connect();
      callers = await publicCallers({ home: homedir(), legacyPersona: config.persona, loadKey: getKey,
        isMember: workspaceAccess(wire, config.owner) });
      callersVerified = true;
    } catch { /* A disconnected relay or locked keychain cannot establish pilot access. */ }
    finally { wire.disconnect(); }
    console.log(JSON.stringify({ configured: true, provider: MODEL_PROVIDER, model: config.model, label: machineLabel(config),
      machine: config.ssh, status: ready ? "ready" : "offline",
      ...(!ready || !callersVerified ? { detail: [!ready ? "Mini or signed gateway is unavailable" : "",
        !callersVerified ? "Caller access could not be verified" : ""].filter(Boolean).join("; ") } : {}),
      callersVerified, callers })); return;
  }
  if (command === "connect" || command === "disconnect") {
    if (config.role !== "gateway") throw new Error("Manage callers on the Mac that holds the workspace-owner key");
    validatePersona(values.name ?? "");
    const owner = secret(config.ownerKey);
    if (getPublicKey(owner) !== config.owner) throw new Error("Owner key does not match the pinned workspace");
    await withCallerLock(homedir(), async () => {
      const wire = new RelayConnection({ url: `ws://127.0.0.1:${config.relayPort}` });
      try {
        await wire.connect();
        const updateMembership = (pubkey: string, admit: boolean) => updateMember(wire, owner, pubkey, admit);
        if (command === "connect") {
          const result = await enrollCaller({ home: homedir(), config, persona: values.name!, loadKey: loadOrCreateKey, updateMembership });
          console.log(`Connected: ${result.persona} (${result.pubkey})`);
        } else {
          await revokeCaller({ home: homedir(), persona: values.name!, legacyPersona: config.persona, loadKey: getKey, updateMembership });
          console.log(`Disconnected: ${values.name}`);
        }
      } finally { wire.disconnect(); }
    });
    return;
  }
  if (command === "install-services") return installServices(config);
  if (command === "start" || command === "stop") return service(config, command === "start");
  if (command === "status") return status(config);
  if (command === "serve") return serve(config);
  if (command === "ask" && config.role === "gateway") return ask(config);
  if (command === "admit" || command === "revoke") {
    const pubkey = positionals[1];
    if (!/^[a-f0-9]{64}$/.test(pubkey ?? "")) throw new Error("Supply a member pubkey");
    if (config.role !== "gateway") throw new Error("Change admission on the caller that holds the workspace-owner key");
    const owner = secret(config.ownerKey);
    if (getPublicKey(owner) !== config.owner) throw new Error("Owner key does not match the pinned workspace");
    await withCallerLock(homedir(), async () => {
      const wire = new RelayConnection({ url: `ws://127.0.0.1:${config.relayPort}` });
      try { await wire.connect(); await updateMember(wire, owner, pubkey, command === "admit"); }
      finally { wire.disconnect(); }
    });
    console.log(`${command === "admit" ? "Admitted" : "Revoked"}: ${pubkey}`); return;
  }
  throw new Error("Unknown command; use fez-mesh help");
}
try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
