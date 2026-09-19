/** Roster-gated inference over loopback; SSH supplies the cross-machine transport. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";
import { buildNip98Header, verifyNip98Header } from "../../../src/protocol/nip98.js";
import { RelayConnection } from "../../../src/protocol/relay.js";
import { KIND_MEMBERSHIP, KIND_BAN_LIST, ROSTER_D, BANS_D } from "../../../src/protocol/kinds.js";
import { WorkspaceState } from "../../../packages/fez-client/src/workspace-state.js";

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function localUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("This prototype requires an HTTP loopback URL (127.0.0.1 or [::1])");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("URL credentials, query and fragment are not allowed");
  return url.href.replace(/\/$/, "");
}

/** Gateway process health without relying on any one caller's roster membership. */
export async function gatewayReady(origin: string): Promise<boolean> {
  const response = await fetch(localUrl(origin) + "/v1/models", { signal: AbortSignal.timeout(8000) });
  await response.body?.cancel();
  return response.status === 401;
}

export async function listenLocal(server: Server, port = 0) {
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local listener");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  // destroyOnReturn:false lets us send 413 instead of resetting the socket.
  for await (const value of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > 262144) { req.resume(); throw new HttpError(413, "Request exceeds 256 KiB"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function route(req: IncomingMessage, origin: string): void {
  if (req.headers.origin || req.headers.host !== new URL(origin).host) throw new HttpError(403, "Local client required");
  if (!((req.method === "GET" && req.url === "/v1/models") ||
    (req.method === "POST" && req.url === "/v1/chat/completions"))) throw new HttpError(404, "Unknown model route");
}

function handler(run: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return (req: IncomingMessage, res: ServerResponse) => {
    void run(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof HttpError ? error.status : 502, {
        error: { message: error instanceof HttpError ? error.message : "Model connection failed" },
      });
    });
  };
}

async function forward(req: IncomingMessage, res: ServerResponse, url: string, body: Buffer, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const cancel = new AbortController();
  const onClose = () => cancel.abort();
  res.once("close", onClose);
  try {
    const response = await fetch(url, { method: req.method, headers, body: req.method === "POST" ? new Uint8Array(body) : undefined,
      redirect: "manual", signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(timeoutMs)]) });
    if (!response.ok) {
      await response.body?.cancel();
      const status = [400, 401, 403, 413, 429, 503].includes(response.status) ? response.status : 502;
      throw new HttpError(status, `Model request refused (${response.status})`);
    }
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" });
    if (response.body) await pipeline(response.body, res);
    else res.end();
  } finally { res.off("close", onClose); }
}

/** A fresh complete relay read per request keeps removals effective on the next call. */
export function workspaceAccess(wire: RelayConnection, owner: string): (pubkey: string) => Promise<boolean> {
  const state = new WorkspaceState();
  state.open(wire.urls[0], "Mesh prototype", owner);
  return async pubkey => {
    // ponytail: one relay read per call; use a synchronized subscription if request volume warrants it.
    const result = await wire.queryWithStatus([
      { kinds: [KIND_MEMBERSHIP], authors: [owner], "#d": [ROSTER_D] },
      { kinds: [KIND_BAN_LIST], "#d": [BANS_D] },
    ], 1000);
    if (result.failures.length || !result.events.some(e => e.kind === KIND_MEMBERSHIP && e.pubkey === owner)) {
      throw new HttpError(503, "Fresh workspace membership is unavailable");
    }
    for (const kind of [KIND_MEMBERSHIP, KIND_BAN_LIST]) {
      for (const event of result.events) if (event.kind === kind && verifyEvent(event)) state.absorb(event);
    }
    return state.isMember(pubkey);
  };
}

export async function startMeshHost(opts: {
  upstream: string; model: string; isMember: (pubkey: string) => Promise<boolean>; timeoutMs?: number;
  port?: number; maxTokens?: number;
}) {
  const upstream = localUrl(opts.upstream);
  if (!opts.model.trim()) throw new Error("A shared model is required");
  if (opts.maxTokens !== undefined && (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1)) throw new Error("Invalid output token cap");
  const used = new Map<string, number>();
  let active = false;
  let origin = "";
  const server = createServer(handler(async (req, res) => {
    route(req, origin);
    const body = await bodyOf(req);
    let auth;
    try {
      auth = verifyNip98Header(req.headers.authorization, { method: req.method!, path: req.url!, origins: [origin], body });
    } catch { throw new HttpError(401, "Malformed signed credential"); }
    const payloads = auth.ok ? auth.event.tags.filter(t => t[0] === "payload") : [];
    if (!auth.ok || (req.method === "POST" && (payloads.length !== 1 || !/^[a-f0-9]{64}$/.test(payloads[0][1] ?? "")))) {
      throw new HttpError(401, "A signed URL, method and request body are required");
    }
    if (!await opts.isMember(auth.pubkey)) throw new HttpError(403, "Not a current workspace member");
    const now = Math.floor(Date.now() / 1000);
    for (const [id, expires] of used) if (expires < now) used.delete(id);
    if (used.has(auth.event.id)) throw new HttpError(401, "Signed request was already used");
    if (used.size >= 1024) throw new HttpError(429, "Too many recent requests");
    used.set(auth.event.id, auth.event.created_at + 60);
    if (req.method === "GET") {
      json(res, 200, { object: "list", data: [{ id: opts.model, object: "model", owned_by: "fez-mesh" }] });
      return;
    }
    let data;
    try { data = JSON.parse(body.toString()); } catch { throw new HttpError(400, "Invalid JSON"); }
    if (!data || data.model !== opts.model || !Array.isArray(data.messages)) throw new HttpError(400, "Use the shared model and a messages array");
    let forwarded = body;
    if (opts.maxTokens !== undefined) {
      const field = data.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
      const requested = data[field] ?? opts.maxTokens;
      if (!Number.isInteger(requested) || requested <= 0) throw new HttpError(400, "A positive output token limit is required");
      delete data.max_tokens;
      delete data.max_completion_tokens;
      data[field] = Math.min(requested, opts.maxTokens);
      forwarded = Buffer.from(JSON.stringify(data));
    }
    if (active) throw new HttpError(429, "The shared model is busy; try again after its current response");
    // ponytail: one inference at a time on this Mini; add a bounded fair queue only if multiple agents need it.
    active = true;
    try { await forward(req, res, upstream + "/chat/completions", forwarded, { "content-type": "application/json" }, opts.timeoutMs ?? 60000); }
    finally { active = false; }
  }));
  const running = await listenLocal(server, opts.port);
  origin = running.url;
  return running;
}

/** pi sends its ordinary local API token; only this process holds the Nostr signing key. */
export async function startMeshGateway(opts: { host: string; secretKey: Uint8Array; token: string; port?: number; timeoutMs?: number;
  resolveCaller?: (authorization: string | undefined) => Promise<Uint8Array | undefined> }) {
  const host = localUrl(opts.host);
  if (!opts.token) throw new Error("A local gateway token is required");
  let origin = "";
  const running = await listenLocal(createServer(handler(async (req, res) => {
    route(req, origin);
    const key = req.headers.authorization === `Bearer ${opts.token}` ? opts.secretKey :
      await opts.resolveCaller?.(req.headers.authorization);
    if (!key) throw new HttpError(401, "Local gateway token required");
    const body = await bodyOf(req);
    const url = host + req.url;
    const header = buildNip98Header(key, url, req.method!, body);
    const event: Event = JSON.parse(Buffer.from(header.slice("Nostr ".length), "base64").toString());
    // Fresh nonce permits identical prompts in the same second while rejecting actual replay.
    const signed = finalizeEvent({ ...event, tags: [...event.tags, ["nonce", randomUUID()]] }, key);
    await forward(req, res, url, body, { "content-type": "application/json",
      Authorization: `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}` }, opts.timeoutMs ?? 65000);
  })), opts.port);
  origin = running.url;
  return running;
}
