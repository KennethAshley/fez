import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piSessionDir, piSessionError } from "../../fez-acp/src/pi-session-error.js";
import { classifyTurnError } from "../../../src/agent/harness.js";

/**
 * A bodiless provider refusal reaches the agent as an empty reply; the
 * reason lives only in pi's session log. Seen live 2026-09-20: quill retried
 * a Chutes 402 three times as "provider down" while the owner waited.
 */
describe("piSessionError", () => {
  test("names the session directory the way pi does", () => {
    expect(piSessionDir("/Users/ken/.fez/agents/work/quill", "/Users/ken")).toBe("/Users/ken/.pi/agent/sessions/--Users-ken-.fez-agents-work-quill--");
  });

  test("returns the last provider error from the newest recent session log", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-pi-home-"));
    const dir = piSessionDir("/w/quill", home);
    fs.mkdirSync(dir, { recursive: true });
    const older = path.join(dir, "2026-09-20T17-00-00-000Z_a.jsonl");
    const newer = path.join(dir, "2026-09-20T17-32-41-370Z_b.jsonl");
    fs.writeFileSync(older, JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "old 500" } }) + "\n");
    fs.writeFileSync(newer, [
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi \"there\"" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "402 status code (no body)" } }),
    ].join("\n") + "\n");
    const now = Date.now();
    fs.utimesSync(older, now / 1000 - 60, now / 1000 - 60);
    fs.utimesSync(newer, now / 1000, now / 1000);
    expect(piSessionError("/w/quill", now, home)).toBe("402 status code (no body)");
  });

  test("ignores stale logs and missing directories", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-pi-home-"));
    const dir = piSessionDir("/w/quill", home);
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "old.jsonl");
    fs.writeFileSync(stale, JSON.stringify({ message: { errorMessage: "ancient" } }) + "\n");
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(stale, old, old);
    expect(piSessionError("/w/quill", Date.now(), home)).toBeUndefined();
    expect(piSessionError("/nowhere", Date.now(), home)).toBeUndefined();
  });

  test("the surfaced refusal classifies as billing, not transient", () => {
    expect(classifyTurnError(new Error("transient: harness returned an empty reply (provider said: 402 status code (no body))"))).toBe("billing");
    expect(classifyTurnError(new Error("transient: harness returned an empty reply"))).toBe("transient");
  });
});
