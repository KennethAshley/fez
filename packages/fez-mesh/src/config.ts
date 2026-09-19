export interface GatewayConfig {
  role: "gateway"; ssh: string; remoteNode: string; remoteCli: string; remoteConfig: string;
  hostPort: number; relayPort: number; port: number; persona: string; model: string;
  contextWindow: number; maxTokens: number; token: string;
  owner: string; ownerKey: string;
  /** What to call the provider machine in the GUI. Defaults to "Mac mini" —
   *  the pilot's box. Every sentence the panel writes about the machine uses
   *  this, so a different box is named correctly without touching the code. */
  label?: string;
}
export const DEFAULT_LABEL = "Mac mini";
export const machineLabel = (config?: { label?: string }) => config?.label?.trim() || DEFAULT_LABEL;
export function validateGateway(config: GatewayConfig): void {
  sshArguments(config);
  if (!/^[a-f0-9]{64}$/.test(config.owner) || !/^agent:[a-z][a-z0-9-]{0,40}$/.test(config.ownerKey)) throw new Error("Invalid workspace owner");
  for (const port of [config.port, config.hostPort, config.relayPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use unprivileged TCP ports");
  }
  if (new Set([config.port, config.hostPort, config.relayPort]).size !== 3) throw new Error("Use distinct ports");
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(config.persona) || !/^[a-zA-Z0-9._:/-]+$/.test(config.model)) throw new Error("Invalid persona or model identifier");
  // The label reaches the GUI as prose, so bound it here rather than letting
  // an arbitrary config string set the width of a settings panel.
  if (config.label !== undefined && (typeof config.label !== "string" || config.label.trim().length > 40)) throw new Error("Use a machine label of at most 40 characters");
  if (typeof config.token !== "string" || config.token.length < 32) throw new Error("Use a random gateway token of at least 32 characters");
  if (!Number.isInteger(config.contextWindow) || config.contextWindow < 8192 ||
    !Number.isInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > config.contextWindow - 4096) throw new Error("Invalid model token limits");
}

export async function configureClient(config: GatewayConfig, home: string): Promise<void> {
  validateGateway(config);
  const file = join(home, ".pi", "agent", "models.json");
  let document: Record<string, unknown> = {};
  try { document = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!document || Array.isArray(document) || typeof document !== "object" ||
    (document.providers !== undefined && (!document.providers || typeof document.providers !== "object" || Array.isArray(document.providers)))) throw new Error("Invalid pi model configuration; left untouched");
  const providers = (document.providers ?? {}) as Record<string, unknown>;
  const provider = { baseUrl: `http://127.0.0.1:${config.port}/v1`, api: "openai-completions", apiKey: config.token,
    models: [{ id: config.model, name: "Mac mini", reasoning: false, input: ["text"], contextWindow: config.contextWindow,
      maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  const persona = fezHomeAt(home, "personas", `${config.persona}.md`);
  const text = `---\nharness: pi\nprovider: fez-mesh-mini\nmodel: ${config.model}\neffort: off\nrespondTo: owner\ndescription: Review supplied code and write concise technical notes using the Mac mini.\n---\nYou are ${config.persona}, a technical assistant running on the owner's Mac mini. Complete the supplied task accurately and concisely. Use tools only when the task requires them. Do not send messages or change external services unless explicitly requested.\n`;
  let existing: string | undefined;
  try { existing = await readFile(persona, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== text) throw new Error("The dedicated persona already has different instructions; left untouched");
  if (providers["fez-mesh-mini"] !== undefined && JSON.stringify(providers["fez-mesh-mini"]) !== JSON.stringify(provider)) throw new Error("fez-mesh-mini already has different configuration; left untouched");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...document, providers: { ...providers, "fez-mesh-mini": provider } }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
  await mkdir(dirname(persona), { recursive: true, mode: 0o700 });
  if (existing === undefined) await writeFile(persona, text, { mode: 0o600, flag: "wx" });
  // A dedicated harness profile prevents any global cloud default or credential fallback.
  const piDir = fezHomeAt(home, "mesh", "mini", "pi");
  await mkdir(piDir, { recursive: true, mode: 0o700 });
  await writeFile(join(piDir, "models.json"), JSON.stringify({ providers: { "fez-mesh-mini": provider } }), { mode: 0o600 });
  await writeFile(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "fez-mesh-mini", defaultModel: config.model,
    defaultThinkingLevel: "off", quietStartup: true, retry: { enabled: false } }), { mode: 0o600 });
}

export function sshArguments(config: GatewayConfig): string[] {
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.ssh)) throw new Error("SSH target must be user@hostname");
  // This pilot uses plain absolute remote paths; reject shell syntax before constructing a remote command.
  for (const path of [config.remoteNode, config.remoteCli, config.remoteConfig]) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(path)) throw new Error("Use absolute remote paths without spaces or shell syntax");
  }
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
}
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fezHomeAt } from "../../../src/shared/fez-home.js";
