#!/usr/bin/env node
/**
 * The router's front door. llama-server binds to loopback and never
 * faces the internet; this is the only public surface, and it exists
 * for the three things llama-server won't do for us:
 *
 *   1. RATE LIMIT per IP. The whole point of this box is that fez works
 *      with nothing installed, which means the endpoint answers
 *      unauthenticated strangers. A tiny model is cheap to serve but not
 *      free, and one script can otherwise occupy the only vCPU forever.
 *   2. CLAMP the request. Routing needs ~96 output tokens (measured: a
 *      96 cap scores identically to 512). A client asking for 4096 —
 *      buggy or hostile — is a 90-second CPU hold on one core, so the
 *      cap is enforced here rather than trusted from the caller.
 *   3. PIN the sampling. temperature 0 makes routing reproducible;
 *      leaving it to the caller means two identical mentions can route
 *      to different agents.
 *
 * Everything else is a transparent proxy, so this stays an ordinary
 * OpenAI-compatible endpoint that any client can point at.
 *
 * Env:
 *   PORT            listen port (default 8081)
 *   UPSTREAM        llama-server base (default http://127.0.0.1:8080)
 *   ROUTER_API_KEY  if set, require `Authorization: Bearer <key>`
 *   RATE_PER_MIN    requests per IP per minute (default 20)
 *   RATE_BURST      concurrent in-flight requests per IP (default 2)
 *   MAX_TOKENS      hard output cap (default 96)
 *   MAX_BODY_BYTES  request body cap (default 65536)
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 8081);
const UPSTREAM = (process.env.UPSTREAM || "http://127.0.0.1:8080").replace(/\/$/, "");
const API_KEY = process.env.ROUTER_API_KEY || "";
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);
const RATE_BURST = Number(process.env.RATE_BURST || 2);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 96);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 65536);

/**
 * Fixed-window counters, deliberately. A token bucket would be smoother
 * but needs per-IP state that has to be swept; this map is cleared
 * wholesale every window, so memory can't creep on a 2 GB box no matter
 * how many distinct IPs show up.
 */
let window = new Map(); // ip -> count
let windowStart = Date.now();
const inflight = new Map(); // ip -> concurrent count

function rateCheck(ip) {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    window = new Map();
    windowStart = now;
  }
  const used = window.get(ip) || 0;
  if (used >= RATE_PER_MIN) return "rate";
  if ((inflight.get(ip) || 0) >= RATE_BURST) return "burst";
  window.set(ip, used + 1);
  return null;
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

/** OpenAI-shaped errors, so a client's existing error handling works. */
const fail = (res, code, message, type) => json(res, code, { error: { message, type, code } });

function clientIp(req) {
  // Caddy is the only thing in front of us and it always sets this;
  // trusting it is safe precisely because llama-server isn't reachable
  // except through Caddy. If that ever changes, this must not be trusted.
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") return json(res, 200, { ok: true, upstream: UPSTREAM });

  // Only the two endpoints a router needs. Everything else on
  // llama-server — /slots, the web UI, /completion — stays private,
  // because this box is a routing appliance, not a public playground.
  const isModels = path === "/v1/models" || path === "/models";
  const isChat = path === "/v1/chat/completions" || path === "/chat/completions";
  if (!isModels && !isChat) return fail(res, 404, `no route for ${path}`, "invalid_request_error");

  if (API_KEY) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${API_KEY}`) return fail(res, 401, "bad or missing API key", "authentication_error");
  }

  const ip = clientIp(req);
  const limited = rateCheck(ip);
  if (limited) {
    res.setHeader("Retry-After", "60");
    return fail(
      res,
      429,
      limited === "rate" ? `rate limit: ${RATE_PER_MIN} requests/minute` : `too many concurrent requests (max ${RATE_BURST})`,
      "rate_limit_error"
    );
  }

  if (isModels) {
    try {
      const upstream = await fetch(`${UPSTREAM}/v1/models`);
      return json(res, upstream.status, await upstream.json());
    } catch {
      return fail(res, 502, "router upstream unavailable", "api_error");
    }
  }

  if (req.method !== "POST") return fail(res, 405, "POST required", "invalid_request_error");

  // Read with a hard cap — an unbounded read is how a proxy on a small
  // box gets killed by a single request.
  const chunks = [];
  let size = 0;
  let aborted = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      break;
    }
    chunks.push(chunk);
  }
  if (aborted) return fail(res, 413, `body over ${MAX_BODY_BYTES} bytes`, "invalid_request_error");

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(res, 400, "body is not valid JSON", "invalid_request_error");
  }

  // The clamps. max_tokens is a ceiling, not an override — a caller
  // asking for less is honoured. Streaming is refused rather than
  // silently dropped: a router returns one tool call, and a client that
  // asked to stream should hear that it isn't happening.
  body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
  body.temperature = 0;
  if (body.stream) return fail(res, 400, "streaming is not supported by this router", "invalid_request_error");

  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  try {
    const upstream = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    fail(res, timedOut ? 504 : 502, timedOut ? "router timed out" : "router upstream unavailable", "api_error");
  } finally {
    const now = (inflight.get(ip) || 1) - 1;
    if (now <= 0) inflight.delete(ip);
    else inflight.set(ip, now);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `fez-router gateway on 127.0.0.1:${PORT} → ${UPSTREAM} · ` +
      `${RATE_PER_MIN}/min/ip, burst ${RATE_BURST}, cap ${MAX_TOKENS} tok${API_KEY ? ", keyed" : ", open"}`
  );
});
