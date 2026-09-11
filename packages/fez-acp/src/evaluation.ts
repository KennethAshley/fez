import fs from "node:fs/promises";
import { accessSync, constants, statSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { invokeWithRetry, type HarnessAdapter, type Persona } from "@fezchat/protocol";

export interface EvaluationRequest { prompt: string; maxCostUsd: number; timeoutMs: number; configHash?: string }
export interface EvaluationReady {
  version: 1; ready: boolean; configHash: string; persona: string; harness: string;
  provider: string | null; model: string | null; tools: string[]; skills: string[]; missingTools: string[];
}
export interface EvaluationResult {
  version: 1; configHash: string; text: string; elapsedMs: number;
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null; withinLimits: boolean | null;
}
type McpServers = NonNullable<Parameters<HarnessAdapter["invoke"]>[3]>;

/** Local probe only: a harness's detect() can prepare credentials or config. */
export function evaluationExecutableAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = path.isAbsolute(command) ? [command]
    : (env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command));
  return candidates.some(file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  });
}

interface EvaluationRuntime { provider: string | null; model: string | null; missing: string[]; configuration: unknown }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function jsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try { return object(JSON.parse(readFileSync(file, "utf8"))); }
  catch { throw new EvaluationError("Runtime configuration could not be read safely"); }
}
function configuredCredential(value: unknown, env: NodeJS.ProcessEnv): boolean {
  if (!nonempty(value) || value.startsWith("!")) return false;
  let missing = false;
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, braced, bare) => {
    const got = env[braced ?? bare]; if (!got) missing = true; return got ?? "";
  });
  return !missing && nonempty(resolved);
}

/** Read the runtime's own defaults and credential presence; never execute a
 * credential command, refresh OAuth, or make a billed provider probe. */
export function evaluationRuntime(opts: { persona: Persona; home?: string; env?: NodeJS.ProcessEnv }): EvaluationRuntime {
  const home = opts.home ?? os.homedir(), env = opts.env ?? process.env, persona = opts.persona;
  const missing: string[] = [];
  let provider: string | null = persona.extra.provider || null, model: string | null = persona.extra.model || null;
  let configuration: unknown = {};
  if (persona.harness === "pi") {
    const agentDir = env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/)/, home) || path.join(home, ".pi", "agent");
    const settings = jsonObject(path.join(agentDir, "settings.json"));
    provider ||= nonempty(settings.defaultProvider) ? settings.defaultProvider : null;
    model ||= nonempty(settings.defaultModel) ? settings.defaultModel : null;
    const ownedPi = path.join(home, ".fez", "bin", "pi");
    const piCommand = existsSync(ownedPi) ? ownedPi : env.PI_ACP_PI_COMMAND || "pi";
    if (!evaluationExecutableAvailable(piCommand, env)) missing.push("pi executable");
    const models = jsonObject(path.join(agentDir, "models.json"));
    const configuredProvider = object(object(models.providers)[provider ?? ""]);
    const credential = object(jsonObject(path.join(agentDir, "auth.json"))[provider ?? ""]);
    const credentialEnv = Object.fromEntries(Object.entries(object(credential.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const storedKey = credential.type === "api_key" && configuredCredential(credential.key, { ...env, ...credentialEnv });
    const oauth = credential.type === "oauth" && nonempty(credential.access) && typeof credential.expires === "number" && Number.isFinite(credential.expires)
      && (credential.expires > Date.now() || nonempty(credential.refresh));
    const envName = `${(provider ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    const environmentKey = nonempty(env[envName]) || (provider === "google" && nonempty(env.GEMINI_API_KEY));
    if (!storedKey && !oauth && !environmentKey && !configuredCredential(configuredProvider.apiKey, env)) missing.push("provider credentials");
    configuration = { settings, provider: configuredProvider, piCommand, agentDir };
  } else if (persona.harness === "claude-code" || persona.harness === "claude") {
    const configDir = env.FEZ_HARNESS_ISOLATE === "1" ? path.join(home, ".fez", "harness", "claude", "shared") : env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
    const settings = jsonObject(path.join(configDir, "settings.json"));
    provider ||= "anthropic";
    model ||= env.ANTHROPIC_MODEL || (nonempty(settings.model) ? settings.model : null);
    const stored = object(jsonObject(path.join(configDir, ".credentials.json")).claudeAiOauth);
    let authenticated = nonempty(env.ANTHROPIC_API_KEY) || nonempty(env.CLAUDE_CODE_OAUTH_TOKEN) || nonempty(stored.accessToken);
    if (!authenticated && process.platform === "darwin") {
      const suffix = configDir === path.join(home, ".claude") ? "" : `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
      try { execFileSync("/usr/bin/security", ["find-generic-password", "-s", `Claude Code-credentials${suffix}`], { stdio: "ignore", timeout: 2000 }); authenticated = true; }
      catch { /* read-only presence check; never refresh or sign in */ }
    }
    if (!authenticated) missing.push("provider credentials");
    configuration = { settings, configDir };
  } else {
    missing.push("provider readiness unsupported for this harness");
  }
  if (!provider) missing.push("selected provider");
  if (!model) missing.push("selected model");
  return { provider, model, missing, configuration };
}

/** OAuth may replace Authorization, but may not silently drop or swap tools. */
export function assertEvaluationToolsUnchanged(before: McpServers, after: McpServers): void {
  const normalized = (servers: McpServers) => servers.map(server => ({ ...server,
    ...("headers" in server ? { headers: server.headers.filter(header => header.name.toLowerCase() !== "authorization") } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(canonical(normalized(before))) !== JSON.stringify(canonical(normalized(after)))) {
    throw new EvaluationError("Evaluation enabled tools changed during credential refresh");
  }
}

/** Public errors carry observations, never raw provider output or credentials. */
export class EvaluationError extends Error {
  constructor(message: string, readonly observation?: Omit<EvaluationResult, "text">) { super(message); }
}

export function parseEvaluationRequest(value: unknown): EvaluationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EvaluationError("Invalid evaluation request");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["prompt", "maxCostUsd", "timeoutMs", "configHash"].includes(key)) ||
      typeof v.prompt !== "string" || !v.prompt.trim() || Buffer.byteLength(v.prompt) > 65_536 ||
      typeof v.maxCostUsd !== "number" || !Number.isFinite(v.maxCostUsd) || v.maxCostUsd <= 0 ||
      typeof v.timeoutMs !== "number" || !Number.isSafeInteger(v.timeoutMs) || v.timeoutMs <= 0 || v.timeoutMs > 900_000 ||
      (v.configHash !== undefined && (typeof v.configHash !== "string" || !/^[a-f0-9]{64}$/.test(v.configHash)))) {
    throw new EvaluationError("Evaluation requires a prompt, positive maxCostUsd allowance, and timeoutMs from 1 to 900000");
  }
  return { prompt: v.prompt, maxCostUsd: v.maxCostUsd, timeoutMs: v.timeoutMs, ...(v.configHash ? { configHash: v.configHash as string } : {}) };
}

export async function readEvaluationRequest(file: string): Promise<EvaluationRequest> {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 128 * 1024) throw new EvaluationError("Evaluation request must be a regular file under 128 KiB");
  const bytes = await fs.readFile(file);
  if (bytes.length > 128 * 1024) throw new EvaluationError("Evaluation request exceeded its size limit");
  try { return parseEvaluationRequest(JSON.parse(bytes.toString("utf8"))); }
  catch (error) { if (error instanceof EvaluationError) throw error; throw new EvaluationError("Invalid evaluation request JSON"); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

/** Hash private configuration; publish only the selected runtime and capability names.
 * Tool names are resolved MCP servers, not a claim that remote services were probed. */
export function evaluationReady(opts: {
  persona: Persona; harness: HarnessAdapter; tools: string[]; skills: string[]; missingTools: string[]; configuration: unknown;
  runtime?: EvaluationRuntime;
}): EvaluationReady {
  const tools = [...new Set(opts.tools)].sort(), skills = [...new Set(opts.skills)].sort(), missingTools = [...new Set([...opts.missingTools, ...opts.runtime?.missing ?? []])].sort();
  const configHash = createHash("sha256").update(JSON.stringify(canonical({
    version: 1, persona: opts.persona, harness: { id: opts.harness.id, command: opts.harness.command, systemPromptMode: opts.harness.systemPromptMode },
    tools, skills, configuration: opts.configuration, runtime: opts.runtime,
  }))).digest("hex");
  return { version: 1, ready: missingTools.length === 0, configHash, persona: opts.persona.id, harness: opts.harness.id,
    provider: opts.runtime?.provider ?? opts.persona.extra.provider ?? null, model: opts.runtime?.model ?? opts.persona.extra.model ?? null, tools, skills, missingTools };
}

/** One owner-configured agent invocation in fresh scratch space. Usage caps are
 * observation-driven: an unmetered engine cannot prove a dollar limit and returns
 * withinLimits:null. Harness usage may exclude separately billed external tools. */
export async function runEvaluation(opts: {
  request: EvaluationRequest; ready: EvaluationReady; harness: HarnessAdapter; mcpServers: McpServers;
  systemPrompt?: string; skillsSection?: string; prepareWorkdir?: (directory: string) => void | (() => void) | Promise<void | (() => void)>;
}): Promise<EvaluationResult> {
  const request = parseEvaluationRequest(opts.request);
  if (!opts.ready.ready) throw new EvaluationError("Agent is missing enabled tools: " + opts.ready.missingTools.join(", "));
  if (request.configHash && request.configHash !== opts.ready.configHash) throw new EvaluationError("Agent configuration changed; review the current configuration before running");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fez-evaluation-"));
  const startedAt = performance.now();
  const controller = new AbortController();
  let costUsd: number | null = null, inputTokens: number | null = null, outputTokens: number | null = null;
  let malformedUsage = false;
  let stopReason: string | undefined;
  const observation = (withinLimits: boolean | null) => ({ version: 1 as const, configHash: opts.ready.configHash,
    elapsedMs: Math.round(performance.now() - startedAt), inputTokens, outputTokens, costUsd, withinLimits });
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const stop = (reason: string) => {
    stopReason = reason;
    controller.abort();
    rejectStopped(new EvaluationError(reason, observation(false)));
  };
  const timer = setTimeout(() => stop("Evaluation deadline exceeded"), request.timeoutMs);
  let cleanConfiguration: void | (() => void) = undefined;
  try {
    cleanConfiguration = await Promise.race([stopped, Promise.resolve(opts.prepareWorkdir?.(directory))]);
    const prompt = [opts.systemPrompt, opts.skillsSection,
      "This is an explicitly designated evaluation task. Work only on the supplied task; no private conversation history has been provided.",
      `The authorized remaining model allowance is USD ${request.maxCostUsd}. Do not initiate separately paid tools or services without their own explicit allowance.`,
      request.prompt].filter(Boolean).join("\n\n");
    const text = await Promise.race([stopped, invokeWithRetry(opts.harness, prompt, directory, undefined, opts.mcpServers, update => {
      if (update.type !== "usage") return;
      for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
        const value = update[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) malformedUsage = true;
      }
      if (Number.isFinite(update.inputTokens) && update.inputTokens! >= 0) inputTokens = Math.max(inputTokens ?? 0, update.inputTokens!);
      if (Number.isFinite(update.outputTokens) && update.outputTokens! >= 0) outputTokens = Math.max(outputTokens ?? 0, update.outputTokens!);
      if (Number.isFinite(update.costUsd) && update.costUsd! >= 0) costUsd = Math.max(costUsd ?? 0, update.costUsd!);
      if (costUsd !== null && costUsd >= request.maxCostUsd) stop("Evaluation model allowance exhausted");
    }, controller.signal, 1)]); // No retry can silently spend the allowance twice.
    if (stopReason) throw new EvaluationError(stopReason, observation(false));
    if (!text.trim()) throw new EvaluationError("Evaluation returned no deliverable", observation(costUsd === null ? null : true));
    return { ...observation(costUsd === null || malformedUsage ? null : true), text };
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError("Agent evaluation failed before delivery", observation(costUsd === null ? null : !stopReason));
  } finally {
    clearTimeout(timer);
    try { cleanConfiguration?.(); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}
