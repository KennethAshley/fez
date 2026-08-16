import { describe, expect, test } from "vitest";
import { classifyTurnError } from "@fez/protocol";

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
  ["API Error: 529 overloaded_error", "transient"],
  ["rate limit exceeded, retry later", "transient"],
  ["claude-agent-acp exited with code 1", "transient"],
  // fatal — surfaced immediately
  ["persona file is malformed", "fatal"],
  ["something unexpected exploded", "fatal"],
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

  test("non-Error values classify by string form", () => {
    expect(classifyTurnError("ECONNREFUSED")).toBe("transient");
    expect(classifyTurnError(42)).toBe("fatal");
  });
});
