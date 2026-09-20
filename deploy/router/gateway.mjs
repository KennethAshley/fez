#!/usr/bin/env node
/**
 * The router's authenticated, rate-limited front door. TypeSafe selects
 * agents; local llama-server covers service failures and richer request
 * shapes. Both return the existing OpenAI-compatible tool-call contract.
 * `/v1/judge` passes arbitrary noul/choice/score questions through to
 * TypeSafe for agents that hold only the router key — no fallback, no
 * generation; a failure is the caller's cue to behave as before.
 * Build through deploy-router.sh: it bundles the shared TypeScript client.
 *
 * Env:
 *   PORT            listen port (default 8081)
 *   UPSTREAM        llama-server base (default http://127.0.0.1:8080)
 *   ROUTER_API_KEY  if set, require `Authorization: Bearer <key>`
 *   TYPESAFE_API_KEY enables TypeSafe as the primary routing model
 *   TYPESAFE_MODEL  pinned model (default jev-1.13.0)
 *   TYPESAFE_TIMEOUT_MS time before local fallback (default 2000)
 *   JUDGE_TIMEOUT_MS  judge route timeout, no fallback (default 5000)
 *   RATE_PER_MIN    requests per IP per minute (default 20)
 *   RATE_BURST      concurrent in-flight requests per IP (default 2)
 *   MAX_TOKENS      hard output cap (default 96)
 *   MAX_BODY_BYTES  request body cap (default 65536)
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chooseTypeSafeRoute, judge, validateJudgeQuestions } from "../../packages/fez-orchestrator/src/typesafe.js";
import { ROUTER_SYSTEM } from "../../packages/fez-orchestrator/src/route-logic.js";

const PORT = Number(process.env.PORT || 8081);
const UPSTREAM = (process.env.UPSTREAM || "http://127.0.0.1:8080").replace(/\/$/, "");
const API_KEY = process.env.ROUTER_API_KEY || "";
const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY || "";
const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL || "jev-1.13.0";
const TYPESAFE_TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 2000);
const JUDGE_TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS || 5000);
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

/**
 * One JSON line per routed request to stdout (journald captures it).
 * No message content, no keys — just enough to answer "did TypeSafe
 * actually get hit, and did it work" without re-deriving it from memory.
 */
function logRoute(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

function clientIp(req) {
  // Caddy is the only thing in front of us and it always sets this;
  // trusting it is safe precisely because llama-server isn't reachable
  // except through Caddy. If that ever changes, this must not be trusted.
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// Jev selects an agent; it cannot generate arbitrary tool arguments. Keep
// richer chat/tool schemas on the existing model instead of silently losing them.
function routingInput(body) {
  if (!Array.isArray(body.messages) || !Array.isArray(body.tools) || body.tools.length < 2) return null;
  const users = body.messages.filter(m => m?.role === "user");
  if (users.length !== 1 || typeof users[0].content !== "string" || body.messages.some(m =>
    m?.role !== "user" && !(m?.role === "system" && m.content === ROUTER_SYSTEM))) return null;
  if (body.tool_choice && !["auto", "required"].includes(body.tool_choice)) return null;
  for (const tool of body.tools) {
    const f = tool?.function, params = f?.parameters;
    if (tool?.type !== "function" || !f || typeof f.name !== "string" || !f.name ||
      typeof f.description !== "string" || !params || params.type !== "object") return null;
    if (params.properties && (typeof params.properties !== "object" || Array.isArray(params.properties))) return null;
    if (params.additionalProperties !== undefined && typeof params.additionalProperties !== "boolean") return null;
    if (Object.entries(params.properties ?? {}).some(([key, schema]) =>
      key !== "task" || schema?.type !== "string" || Object.keys(schema).some(k => !["type", "description"].includes(k)))) return null;
    if (params.required && (!Array.isArray(params.required) || params.required.some(key => key !== "task" || !params.properties?.task))) return null;
    if (Object.keys(params).some(key => !["type", "properties", "required", "additionalProperties"].includes(key))) return null;
  }
  const criteria = Object.fromEntries(body.tools.map(t => [t.function.name, t.function.description]));
  if (Object.keys(criteria).length !== body.tools.length) return null;
  return { message: users[0].content, criteria };
}

/**
 * Generic judgment. The body is TypeSafe's own shape (state + questions)
 * and the reply is TypeSafe's own answers, validated on the way back so
 * a caller never sees a partial or mistyped result. Deliberately no
 * llama fallback: a small chat model can't produce calibrated
 * probabilities, and a caller that can't get a judgment keeps doing what
 * it did before there was one.
 */
async function handleJudge(res, ip, body) {
  if (!TYPESAFE_KEY) return fail(res, 503, "judge unavailable: TypeSafe is not configured", "api_error");
  if (body.state === undefined || body.state === null) return fail(res, 400, "state is required", "invalid_request_error");
  try {
    validateJudgeQuestions(body.questions);
  } catch (err) {
    return fail(res, 400, err?.message || "invalid questions", "invalid_request_error");
  }
  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  const startedAt = Date.now();
  const names = Object.keys(body.questions);
  try {
    const result = await judge(TYPESAFE_KEY, body.state, body.questions, { model: TYPESAFE_MODEL, timeoutMs: JUDGE_TIMEOUT_MS });
    res.setHeader("X-Fez-Judge-Model", result.model);
    logRoute({ route: "judge", questions: names, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedAt });
    return json(res, 200, { model: result.model, answers: result.answers,
      usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens } });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    logRoute({ route: "judge", questions: names, error: err?.message || String(err), latencyMs: Date.now() - startedAt });
    return fail(res, timedOut ? 504 : 502, timedOut ? "judge timed out" : "judge upstream unavailable", "api_error");
  } finally {
    const now = (inflight.get(ip) || 1) - 1;
    if (now <= 0) inflight.delete(ip);
    else inflight.set(ip, now);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") return json(res, 200, { ok: true, upstream: UPSTREAM,
    primary: TYPESAFE_KEY ? "typesafe" : "local", model: TYPESAFE_KEY ? TYPESAFE_MODEL : undefined });

  // Only the two endpoints a router needs. Everything else on
  // llama-server — /slots, the web UI, /completion — stays private,
  // because this box is a routing appliance, not a public playground.
  const isModels = path === "/v1/models" || path === "/models";
  const isChat = path === "/v1/chat/completions" || path === "/chat/completions";
  const isJudge = path === "/v1/judge" || path === "/judge";
  if (!isModels && !isChat && !isJudge) return fail(res, 404, `no route for ${path}`, "invalid_request_error");

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
    if (TYPESAFE_KEY) return json(res, 200, { object: "list", data: [
      { id: "fez-router", object: "model", created: 0, owned_by: "fez" },
    ] });
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "body must be an object", "invalid_request_error");

  if (isJudge) return handleJudge(res, ip, body);

  // The clamps. max_tokens is a ceiling, not an override — a caller
  // asking for less is honoured. Streaming is refused rather than
  // silently dropped: a router returns one tool call, and a client that
  // asked to stream should hear that it isn't happening.
  body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
  body.temperature = 0;
  if (body.stream) return fail(res, 400, "streaming is not supported by this router", "invalid_request_error");

  inflight.set(ip, (inflight.get(ip) || 0) + 1);
  const startedAt = Date.now();
  let typesafeError;
  try {
    const input = TYPESAFE_KEY ? routingInput(body) : null;
    if (input) {
      try {
        const decision = await chooseTypeSafeRoute(TYPESAFE_KEY, input.message, input.criteria,
          { model: TYPESAFE_MODEL, timeoutMs: TYPESAFE_TIMEOUT_MS });
        const picked = body.tools.find(t => t.function.name === decision.choice).function;
        const args = picked.parameters.properties?.task ? { task: input.message } : {};
        res.setHeader("X-Fez-Router-Backend", "typesafe");
        res.setHeader("X-Fez-Router-Confidence", String(decision.confidence));
        logRoute({ backend: "typesafe", agent: decision.choice, confidence: decision.confidence,
          probabilities: decision.probabilities, latencyMs: Date.now() - startedAt });
        return json(res, 200, { id: `chatcmpl-${randomUUID()}`, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: TYPESAFE_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
            { id: `call_${randomUUID()}`, type: "function", function: { name: decision.choice, arguments: JSON.stringify(args) } },
          ] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: decision.inputTokens, completion_tokens: decision.outputTokens,
            total_tokens: decision.inputTokens + decision.outputTokens } });
      } catch (err) {
        typesafeError = err?.message || String(err);
        console.warn("TypeSafe unavailable or invalid response; using local router");
      }
    }
    res.setHeader("X-Fez-Router-Backend", "local");
    const upstream = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    logRoute({ backend: "local", typesafeError, status: upstream.status, latencyMs: Date.now() - startedAt });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    logRoute({ backend: "error", typesafeError, error: err?.message || String(err),
      latencyMs: Date.now() - startedAt });
    fail(res, timedOut ? 504 : 502, timedOut ? "router timed out" : "router upstream unavailable", "api_error");
  } finally {
    const now = (inflight.get(ip) || 1) - 1;
    if (now <= 0) inflight.delete(ip);
    else inflight.set(ip, now);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `fez-router gateway on 127.0.0.1:${server.address().port} → ${UPSTREAM} · ` +
      `${RATE_PER_MIN}/min/ip, burst ${RATE_BURST}, cap ${MAX_TOKENS} tok${API_KEY ? ", keyed" : ", open"}`
  );
});
