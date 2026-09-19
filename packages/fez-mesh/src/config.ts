/** The pilot persona's pi provider id — also its modelProfile. */
export const PILOT_PROVIDER = "fez-mesh-mini";

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
  const provider = { baseUrl: `http://127.0.0.1:${config.port}/v1`, api: "openai-completions", apiKey: config.token,
    models: [{ id: config.model, name: "Mac mini", reasoning: false, input: ["text"], contextWindow: config.contextWindow,
      maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  // The pilot is a private model profile — the same layout fez-acp's
  // activateModelProfile gates on at agent start — so it can never fall
  // through to pi's global registry or inherited cloud credentials.
  // ~/.pi/agent/models.json is deliberately left alone.
  const profileDir = fezHomeAt(home, "model-profiles", PILOT_PROVIDER, config.persona);
  let saved: { providers?: Record<string, unknown> } | undefined;
  try { saved = JSON.parse(await readFile(join(profileDir, "models.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid pilot model profile; left untouched", { cause: error }); }
  const current = saved?.providers?.[PILOT_PROVIDER];
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(provider)) throw new Error(`${PILOT_PROVIDER} already has different model configuration; left untouched`);
  await privateJson(join(profileDir, "profile.json"), { provider: PILOT_PROVIDER, model: config.model, persona: config.persona });
  await privateJson(join(profileDir, "models.json"), { providers: { [PILOT_PROVIDER]: provider } });
  await privateJson(join(profileDir, "settings.json"), { defaultProvider: PILOT_PROVIDER, defaultModel: config.model,
    defaultThinkingLevel: "off", quietStartup: true, retry: { enabled: false } });

  const persona = fezHomeAt(home, "personas", `${config.persona}.md`);
  const text = `---\nharness: pi\nprovider: ${PILOT_PROVIDER}\nmodelProfile: ${PILOT_PROVIDER}\nmodel: ${config.model}\neffort: off\nrespondTo: owner\ndescription: Review supplied code and write concise technical notes using the Mac mini.\n---\nYou are ${config.persona}, a technical assistant running on the owner's Mac mini. Complete the supplied task accurately and concisely. Use tools only when the task requires them. Do not send messages or change external services unless explicitly requested.\n`;
  // Installs made before modelProfile existed wrote exactly this text minus that one line.
  const legacy = text.replace(`modelProfile: ${PILOT_PROVIDER}\n`, "");
  let existing: string | undefined;
  try { existing = await readFile(persona, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== text && existing !== legacy) throw new Error("The dedicated persona already has different instructions; left untouched");
  await mkdir(dirname(persona), { recursive: true, mode: 0o700 });
  if (existing === undefined) await writeFile(persona, text, { mode: 0o600, flag: "wx" });
  else if (existing === legacy) await writeFile(persona, text, { mode: 0o600 });
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fezHomeAt } from "../../../src/shared/fez-home.js";
import { privateJson } from "./enrollment.js";
