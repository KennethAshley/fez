import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename, rm, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { fezHomeAt } from "../../../src/shared/fez-home.js";
import type { GatewayConfig } from "./config.js";

import { MODEL_PROVIDER } from "./state.js";
export { MODEL_PROVIDER } from "./state.js";
type Caller = { persona: string; pubkey: string; tokenHash: string };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const registryPath = (home: string) => fezHomeAt(home, "mesh", "mini", "callers.json");
const profilePath = (home: string, persona: string) => fezHomeAt(home, "model-profiles", MODEL_PROVIDER, persona);

export function validatePersona(persona: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(persona)) throw new Error("Persona name must be 2–32 lowercase letters, digits or hyphens, and cannot start with a hyphen");
}

async function callers(home: string): Promise<Caller[]> {
  let raw: string;
  try { raw = await readFile(registryPath(home), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw new Error("Invalid private caller registry"); }
  if (!Array.isArray(rows) || !rows.every(row => {
    if (!row || typeof row !== "object") return false;
    const value = row as Partial<Caller>;
    try { validatePersona(value.persona ?? ""); } catch { return false; }
    return /^[a-f0-9]{64}$/.test(value.pubkey ?? "") && /^[a-f0-9]{64}$/.test(value.tokenHash ?? "");
  })) throw new Error("Invalid private caller registry");
  const result = rows as Caller[];
  if (new Set(result.map(row => row.persona)).size !== result.length ||
    new Set(result.map(row => row.tokenHash)).size !== result.length) throw new Error("Duplicate private caller identity");
  return result;
}

/** One local operator mutation at a time; fail visibly rather than racing roster replacements. */
export async function withCallerLock<T>(home: string, work: () => Promise<T>): Promise<T> {
  const file = fezHomeAt(home, "mesh", "mini", "callers.lock");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Mini admission change is already in progress; retry when it finishes (remove a stale callers.lock only after confirming no command is running)", { cause: error });
    throw error;
  }
  try { return await work(); }
  finally { await handle.close(); await rm(file, { force: true }); }
}

async function privateJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export async function listCallers(home: string): Promise<Array<{ persona: string; pubkey: string }>> {
  return (await callers(home)).map(({ persona, pubkey }) => ({ persona, pubkey }));
}

/** Include the pre-upgrade pilot only while its own key is on the fresh owner-signed roster. */
export async function publicCallers(opts: { home: string; legacyPersona: string;
  loadKey: (name: string) => string | undefined; isMember: (pubkey: string) => Promise<boolean> }) {
  const rows = await listCallers(opts.home);
  const hex = opts.loadKey(`agent:${opts.legacyPersona}`);
  if (!hex || !/^[a-f0-9]{64}$/.test(hex)) throw new Error("Configured pilot identity is unavailable");
  const pubkey = getPublicKey(Buffer.from(hex, "hex"));
  if (rows.some(row => row.persona === opts.legacyPersona && row.pubkey !== pubkey))
    throw new Error("Configured pilot identity does not match its private caller profile");
  const keys = [...new Set([...rows.map(row => row.pubkey), pubkey])];
  const allowed = new Map(await Promise.all(keys.map(async key => [key, await opts.isMember(key)] as const)));
  const active = rows.filter(row => allowed.get(row.pubkey));
  if (allowed.get(pubkey) && !active.some(row => row.pubkey === pubkey))
    active.unshift({ persona: opts.legacyPersona, pubkey });
  return active;
}

export async function enrollCaller(opts: {
  home: string; config: GatewayConfig; persona: string;
  loadKey: (name: string) => string;
  updateMembership: (pubkey: string, admit: boolean) => Promise<void>;
}): Promise<{ persona: string; pubkey: string }> {
  const { home, config, persona } = opts;
  validatePersona(persona);
  const key = Buffer.from(opts.loadKey(`agent:${persona}`), "hex");
  if (key.length !== 32) throw new Error("Invalid agent identity");
  const pubkey = getPublicKey(key);
  const rows = await callers(home);
  const prior = rows.find(row => row.persona === persona);
  if (prior && prior.pubkey !== pubkey) throw new Error("Agent identity changed; revoke the old caller before reconnecting");
  const profile = profilePath(home, persona);
  let token: string | undefined;
  if (prior) {
    try {
      const saved = JSON.parse(await readFile(join(profile, "models.json"), "utf8"));
      const candidate = saved?.providers?.[MODEL_PROVIDER]?.apiKey;
      if (typeof candidate === "string" && hash(candidate) === prior.tokenHash) token = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid private model profile; left untouched", { cause: error });
    }
  }
  token ??= randomBytes(32).toString("base64url");
  await opts.updateMembership(pubkey, true);
  const provider = { baseUrl: `http://127.0.0.1:${config.port}/v1`, api: "openai-completions", apiKey: token,
    models: [{ id: config.model, name: "Mac mini", reasoning: false, input: ["text"], contextWindow: config.contextWindow,
      maxTokens: config.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  await privateJson(join(profile, "profile.json"), { provider: MODEL_PROVIDER, model: config.model, persona });
  await privateJson(join(profile, "models.json"), { providers: { [MODEL_PROVIDER]: provider } });
  await privateJson(join(profile, "settings.json"), { defaultProvider: MODEL_PROVIDER, defaultModel: config.model,
    defaultThinkingLevel: "off", quietStartup: true, retry: { enabled: false } });
  await privateJson(registryPath(home), [...rows.filter(row => row.persona !== persona), { persona, pubkey, tokenHash: hash(token) }]);
  return { persona, pubkey };
}

export async function revokeCaller(opts: { home: string; persona: string; legacyPersona?: string;
  loadKey?: (name: string) => string | undefined; updateMembership: (pubkey: string, admit: boolean) => Promise<void> }): Promise<void> {
  validatePersona(opts.persona);
  const rows = await callers(opts.home);
  const prior = rows.find(row => row.persona === opts.persona);
  let pubkey = prior?.pubkey;
  if (!pubkey && opts.persona === opts.legacyPersona) {
    const hex = opts.loadKey?.(`agent:${opts.persona}`);
    if (!hex || !/^[a-f0-9]{64}$/.test(hex)) throw new Error("Configured pilot identity is missing; cannot revoke it");
    pubkey = getPublicKey(Buffer.from(hex, "hex"));
  }
  if (!pubkey) return;
  await opts.updateMembership(pubkey, false);
  if (!prior) return;
  await privateJson(registryPath(opts.home), rows.filter(row => row.persona !== opts.persona));
  const profile = profilePath(opts.home, opts.persona);
  for (const file of ["profile.json", "models.json", "settings.json"]) await rm(join(profile, file), { force: true });
}

/** Read the private registry and current key on every request so a revoked token cannot linger in memory. */
export async function resolveCallerToken(opts: { home: string; authorization: string | undefined; loadKey: (name: string) => string | undefined }): Promise<Uint8Array | undefined> {
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(opts.authorization ?? "");
  if (!match) return undefined;
  const row = (await callers(opts.home)).find(caller => caller.tokenHash === hash(match[1]));
  if (!row) return undefined;
  const hex = opts.loadKey(`agent:${row.persona}`);
  if (!hex || !/^[a-f0-9]{64}$/.test(hex)) return undefined;
  const key = Buffer.from(hex, "hex");
  return getPublicKey(key) === row.pubkey ? key : undefined;
}
