import { describe, expect, test } from "vitest";
import { classifyTurnError, modelRecoveryHint } from "@fezchat/protocol";

/**
 * Turn-error taxonomy (Buzz's precision rationale): auth must NEVER be
 * classified transient — retrying it wastes attempts and delays the
 * visible failure; transient must not be fatal — that skips a retry
 * that would have worked. Every string below was observed live or comes
 * from Buzz's documented field patterns.
 */
const CASES: [string, ReturnType<typeof classifyTurnError>][] = [
  // auth — never retried
  ["Internal error: Failed to authenticate: OAuth session expired and could not be refreshed", "auth"],
  ["Authentication required", "auth"],
  ["OAuth access token has expired. Re-authenticate to continue.", "auth"],
  ["API Error: 401 unauthorized", "auth"],
  ["Not logged in · Please run /login", "auth"],
  // transient — retried with backoff
  ["connect ECONNREFUSED 127.0.0.1:8080", "transient"],
  ["read ECONNRESET", "transient"],
  ["socket hang up", "transient"],
  ["request timed out", "transient"],
  ["Harness timed out after 300s", "transient"],
  ["claude-agent-acp went silent for 30000ms mid-turn", "transient"],
  ["claude-agent-acp hit the 300000ms hard deadline without finishing", "transient"],
  ["API Error: 529 overloaded_error", "transient"],
  ["rate limit exceeded, retry later", "transient"],
  ["claude-agent-acp exited with code 1", "transient"],
  // 5xx from a provider is a server-side blip, not a verdict on the
  // prompt — before prompt rejections were surfaced these self-healed
  // via the idle-timeout path, and classifying them fatal regressed a
  // one-blip 503 into a permanently failed turn with an observer alert.
  ["Request failed with status 503", "transient"],
  ["502 Bad Gateway", "transient"],
  ["API Error: 500 internal server error", "transient"],
  ["Service Unavailable", "transient"],
  ["upstream temporarily unavailable", "transient"],
  ["model temporarily unavailable: status 503", "transient"],
  ["model endpoint network timed out", "transient"],
  // A process wrapper does not make an invalid model retryable.
  ['pi-acp exited before reply: llm model not found: (missing-model) 404 Not Found', "fatal"],
  ['API Error: 404 {"code":"model_not_found"}', "fatal"],
  ['The model `missing-model` does not exist', "fatal"],
  // fatal — surfaced immediately
  ["persona file is malformed", "fatal"],
  ["something unexpected exploded", "fatal"],
  ["processed 502 items and found a malformed record", "fatal"], // a number is not a status
];

describe("classifyTurnError", () => {
  for (const [message, expected] of CASES) {
    test(`"${message.slice(0, 50)}" → ${expected}`, () => {
      expect(classifyTurnError(new Error(message))).toBe(expected);
    });
  }

  test("AbortError → aborted regardless of message", () => {
    const err = new Error("Re-authenticate"); // adversarial: auth-looking message
    err.name = "AbortError";
    expect(classifyTurnError(err)).toBe("aborted");
  });

  test("a missing model cause remains fatal inside a transient-looking wrapper", () => {
    const err = new Error("pi-acp exited before reply", { cause: new Error("model not found: missing-model") });
    expect(classifyTurnError(err)).toBe("fatal");
    const abort = new Error("model not found"); abort.name = "AbortError";
    expect(classifyTurnError(abort)).toBe("aborted");
    expect(classifyTurnError(new Error("API Error: 401 model not found"))).toBe("auth");
    const cycle = new Error("network unavailable"); cycle.cause = cycle;
    expect(classifyTurnError(cycle)).toBe("transient");
  });

  test("recovery advice only accompanies a missing model, including a wrapped cause", () => {
    for (const err of [new Error("model not found"), new Error('Model "retired" not found'),
      new Error("Unknown model: retired"), new Error('{"code":"model_not_found"}'),
      new Error("process exited", { cause: new Error("model not found") })]) {
      expect(modelRecoveryHint(err)).toMatch(/Agents.*edit.*model.*save.*restart.*resend/is);
    }
    for (const message of ["model temporarily unavailable: status 503", "model configuration file not found",
      "404 endpoint not found", "API Error: 401 model not found"]) expect(modelRecoveryHint(new Error(message))).toBe("");
    const abort = new Error("model not found"); abort.name = "AbortError";
    expect(modelRecoveryHint(abort)).toBe("");
  });

  test("non-Error values classify by string form", () => {
    expect(classifyTurnError("ECONNREFUSED")).toBe("transient");
    expect(classifyTurnError(42)).toBe("fatal");
  });
});
