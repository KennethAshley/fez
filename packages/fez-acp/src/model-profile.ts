import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fezHomeAt } from "../../../src/shared/fez-home.js";

/** A saved identity profile must never fall through to pi's global model or credentials. */
export function activateModelProfile(persona: { id: string; harness: string; extra: Record<string, string> }, home: string, env: NodeJS.ProcessEnv): boolean {
  const profile = persona.extra.modelProfile;
  if (!profile) { delete env.FEZ_PI_REQUIRED_MODEL; return false; }
  const fail = () => new Error(`Model profile for @${persona.id} is unavailable or does not match this agent. Reconnect the model from the agent editor before restarting.`);
  if (persona.harness !== "pi" || !/^[a-z][a-z0-9-]{1,95}$/.test(profile) ||
    !/^[a-z0-9][a-z0-9-]{1,31}$/.test(persona.id) || profile !== persona.extra.provider || !persona.extra.model) throw fail();
  const directory = fezHomeAt(home, "model-profiles", profile, persona.id);
  try {
    const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const read = (file: string) => object(JSON.parse(readFileSync(join(directory, file), "utf8")));
    const binding = read("profile.json"), settings = read("settings.json"), providers = object(read("models.json").providers);
    const provider = object(providers[profile]);
    if (binding.persona !== persona.id || binding.provider !== profile || binding.model !== persona.extra.model ||
      settings.defaultProvider !== profile || settings.defaultModel !== persona.extra.model || object(settings.retry).enabled !== false ||
      Object.keys(providers).length !== 1 || typeof provider.apiKey !== "string" || !provider.apiKey ||
      !Array.isArray(provider.models) || !provider.models.some(model => object(model).id === persona.extra.model)) throw fail();
  } catch { throw fail(); }
  env.PI_CODING_AGENT_DIR = directory;
  env.FEZ_PI_REQUIRED_MODEL = `${profile}/${persona.extra.model}`;
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";
  return true;
}
