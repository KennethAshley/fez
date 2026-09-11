import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { isAbsolute } from "node:path";
import type { SubmissionContext, SubmissionStatus, SubmissionVersion } from "@fezchat/extension-api";
import type { Exec } from "./sandbox.js";

const API = "https://stg.numinous.earth";
const ENDPOINT = "wss://test.finney.opentensor.ai:443";
export const COOLDOWN = 3 * 24 * 60 * 60 * 1000;
type Pair = ReturnType<Keyring["addFromUri"]>;
export type Agent = SubmissionVersion & { track: string };

export function remaining(deadline: number, cap = 15000): number {
  const ms = Math.min(cap, deadline - Date.now());
  if (ms <= 0) throw new Error("Numinous operation timed out");
  return ms;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Numinous response");
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 512): string {
  // eslint-disable-next-line no-control-regex -- Reject or strip control characters from untrusted text.
  if (typeof value !== "string" || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Numinous response");
  return value;
}

export function id(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new Error("Invalid Numinous response");
  return result;
}

function date(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error("Invalid Numinous response timestamp");
  return new Date(result).toISOString();
}

export async function identity(ctx: SubmissionContext, exec: Exec, deadline: number): Promise<Pair> {
  if (!isAbsolute(ctx.walletBin) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ctx.persona)) throw new Error("Invalid wallet path or persona");
  let network;
  try { network = await exec(ctx.walletBin, ["network"], { timeoutMs: remaining(deadline), maxBytes: 4096 }); }
  catch { throw new Error("Could not verify wallet network; testnet required"); }
  const lines = network.stdout.trim().split(/\r?\n/);
  const networks = lines.filter(line => line.startsWith("network:"));
  const endpoints = lines.filter(line => line.startsWith("endpoint:"));
  if (network.code !== 0 || networks.length !== 1 || !/^network: test(?: {2}⚠️ {2}play money)?$/.test(networks[0]) || endpoints.length !== 1 || endpoints[0] !== `endpoint: ${ENDPOINT}`)
    throw new Error("Numinous requires wallet network test and the exact testnet endpoint");
  try {
    const result = await exec(ctx.walletBin, ["export-hotkey", ctx.persona, "--existing", "--json"], { timeoutMs: remaining(deadline), maxBytes: 16384 });
    if (result.code !== 0) throw new Error();
    const exported = record(JSON.parse(result.stdout));
    const keyfile = record(exported.keyfile);
    if (exported.created !== false || exported.persona !== ctx.persona || typeof exported.ss58Address !== "string" || (ctx.hotkey && ctx.hotkey !== exported.ss58Address)) throw new Error();
    const phrase = text(keyfile.secretPhrase, 1024);
    await cryptoWaitReady();
    const pair = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(phrase);
    if (pair.address !== exported.ss58Address || (keyfile.ss58Address !== undefined && pair.address !== keyfile.ss58Address)) { pair.lock(); throw new Error(); }
    return pair;
  } catch { throw new Error("Could not load existing wallet hotkey"); }
}

export async function request(pair: Pair, route: string, fetcher: typeof fetch, deadline: number, now: number, upload?: { bytes: Buffer; sha256: string; name: string }): Promise<unknown> {
  const payload = `${pair.address}:${upload?.sha256 ?? Math.floor(now / 1000)}`;
  const headers = {
    Authorization: `Bearer ${Buffer.from(pair.sign(Buffer.from(payload))).toString("base64")}`,
    "Miner-Public-Key": Buffer.from(pair.publicKey).toString("hex"),
    Miner: pair.address, "X-Payload": payload,
  };
  let body: FormData | undefined;
  if (upload) {
    body = new FormData();
    body.append("agent_file", new Blob([new Uint8Array(upload.bytes)], { type: "text/x-python" }), "agent.py");
    body.append("name", upload.name);
    body.append("track", "SIGNAL");
  }
  let response;
  try {
    response = await fetcher(API + route, {
      method: upload ? "POST" : "GET", headers, body,
      redirect: "error", signal: AbortSignal.timeout(remaining(deadline, upload ? 20000 : 15000)),
    });
  } catch { throw new Error(upload ? "Numinous upload outcome unknown; check status before any manual retry" : "Numinous request failed or timed out"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Numinous API returned HTTP ${response.status}${upload ? "; check status before any manual retry" : ""}`);
  }
  try {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error(upload ? "Numinous upload response invalid; acceptance unknown, check status before any manual retry" : "Invalid or oversized Numinous response"); }
}

export async function agents(pair: Pair, fetcher: typeof fetch, deadline: number, now: () => number): Promise<Agent[]> {
  const all: Agent[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = record(await request(pair, `/api/v3/miner/agents?limit=100&offset=${offset}`, fetcher, deadline, now()));
    if (!Array.isArray(page.items) || page.items.length > 100) throw new Error("Invalid Numinous response");
    if (page.total_count !== undefined) {
      if (typeof page.total_count !== "number" || !Number.isSafeInteger(page.total_count) || page.total_count < 0 || page.total_count > 1000 || (total !== undefined && total !== page.total_count)) throw new Error("Invalid Numinous pagination response");
      total = page.total_count;
      if (page.items.length !== Math.min(100, total - offset)) throw new Error("Incomplete Numinous pagination response");
    } else if (total !== undefined) throw new Error("Inconsistent Numinous pagination response");
    for (const item of page.items) {
      const value = record(item);
      const versionId = id(value.version_id);
      if (seen.has(versionId) || typeof value.version_number !== "number" || !Number.isSafeInteger(value.version_number) || value.version_number < 0) throw new Error("Invalid Numinous response version");
      seen.add(versionId);
      all.push({ id: versionId, name: text(value.agent_name), version: value.version_number,
        track: text(value.track, 32), createdAt: date(value.created_at),
        activatedAt: value.activated_at === null ? null : date(value.activated_at) });
    }
    if (page.items.length < 100 || (total !== undefined && all.length === total)) return all;
  }
  throw new Error("Numinous pagination limit exceeded; status is incomplete");
}

export function statusOf(hotkey: string, all: Agent[], now: number, uid?: number): SubmissionStatus {
  const versions = all.filter(a => a.track === "SIGNAL").sort((a, b) => b.version - a.version).map(({ track: _, ...v }) => v);
  const active = versions.find(v => v.activatedAt !== null && Date.parse(v.activatedAt) <= now);
  const latest = versions[0];
  const phase = !latest ? "not-submitted" : active?.id === latest.id ? "active" : "pending";
  // Upstream doesn't publish whether cooldown is per-track; use every upload conservatively.
  const lastUpload = all.length ? Math.max(...all.map(v => Date.parse(v.createdAt))) : undefined;
  return {
    hotkey, ...(uid !== undefined ? { uid } : {}), phase, versions, checkedAt: new Date(now).toISOString(),
    ...(active ? { activeVersionId: active.id } : {}),
    ...(lastUpload !== undefined ? { nextUploadAt: new Date(lastUpload + COOLDOWN).toISOString() } : {}),
    detail: `${!latest ? "No SIGNAL submission reported." : phase === "active" ? "Latest SIGNAL version has reached its reported activation time." : `Latest SIGNAL version is pending activation.${active ? " An older version has reached its reported activation time." : ""}`} Validator execution, inference, scoring and rewards are unverified.`,
  };
}

export async function uidFor(ctx: SubmissionContext, hotkey: string, exec: Exec, deadline: number): Promise<number | undefined> {
  try {
    const result = await exec(ctx.walletBin, ["metagraph", "--netuid", "155", "--hotkey", hotkey, "--require-testnet", "--json"], { timeoutMs: remaining(deadline), maxBytes: 16384 });
    if (result.code !== 0) return undefined;
    const data = record(JSON.parse(result.stdout));
    return typeof data.uid === "number" && Number.isInteger(data.uid) && data.uid >= 0 && data.uid <= 65535 ? data.uid : undefined;
  } catch { return undefined; }
}
