import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDefs, usesJudge } from "../../fez-workflows/src/defs.js";
import { evalCondition } from "../../fez-workflows/src/expr.js";
import { judgeConfigFromEnv, judgeState, judgeStatements, judgeVars, nouls } from "../../fez-workflows/src/judge.js";
import type { JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

function loadYaml(yamlText: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wf-judge-"));
  fs.writeFileSync(path.join(dir, "test.yaml"), yamlText);
  return loadDefs(dir);
}

describe("judged workflow definitions", () => {
  test("when, judge and wait_until load and mark the workflow as needing the judge", () => {
    const [def] = loadYaml(`
name: judged
channel: general
trigger: { on: message, from: researcher, when: "the message states a finding rather than asking a question", when_at: 0.7 }
steps:
  - judge: { ask: { needs_review: "the finding would benefit from a second opinion", blocker: "the message reports a blocker" } }
    id: check
  - say: "@reviewer please look: {{trigger.text}}"
    if: 'judge.needs_review >= 0.8 && judge.blocker < 0.3'
  - wait_until: { statement: "the reviewer has approved or signed off", from: reviewer, timeout: 2h, at: 0.85 }
  - say: "Reviewed by {{latest.author_name}} — shipping."
`);
    expect(def.steps).toHaveLength(4);
    expect(usesJudge(def)).toBe(true);
  });

  test("a plain workflow does not need the judge", () => {
    const [def] = loadYaml(`
name: plain
channel: general
trigger: { on: message, filter: "deploy" }
steps:
  - say: "on it"
`);
    expect(usesJudge(def)).toBe(false);
  });

  test.each([
    ["when on a reaction trigger", `trigger: { on: reaction, when: "x" }\nsteps:\n  - say: hi`, /when.*message/],
    ["an empty when", `trigger: { on: message, when: "  " }\nsteps:\n  - say: hi`, /non-empty/],
    ["when_at out of range", `trigger: { on: message, when: "x", when_at: 1.5 }\nsteps:\n  - say: hi`, /\(0, 1\]/],
    ["judge with no statements", `trigger: { on: message }\nsteps:\n  - judge: { ask: {} }`, /1–32/],
    ["judge with a bad name", `trigger: { on: message }\nsteps:\n  - judge: { ask: { "needs review": "x" } }`, /alphanumeric/],
    ["wait_until without a statement", `trigger: { on: message }\nsteps:\n  - wait_until: { timeout: 1h }`, /statement/],
    ["wait_until with a bad bar", `trigger: { on: message }\nsteps:\n  - wait_until: { statement: "x", at: 0 }`, /\(0, 1\]/],
    ["wait_until first in a schedule run", `trigger: { on: schedule, every: 1h }\nsteps:\n  - wait_until: { statement: "x" }`, /schedule run has no thread/],
  ])("rejects %s", (_label, body, pattern) => {
    expect(() => loadYaml(`name: t\nchannel: general\n${body}\n`)).toThrow(pattern);
  });
});

describe("judge helpers", () => {
  const result = (values: Record<string, number>): JudgeResult => ({
    model: "jev-1.13.0", inputTokens: 5, outputTokens: 2,
    answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: "noul", noul: v }])),
  });

  test("statements become nouls over the same state and come back as named probabilities", async () => {
    let seen: { state: unknown; questions: Record<string, unknown> } | undefined;
    const values = await judgeStatements(async (state, questions) => { seen = { state, questions }; return result({ a: 0.9, b: 0.1 }); },
      { message: { text: "hi" } }, { a: "statement a", b: "statement b" });
    expect(values).toEqual({ a: 0.9, b: 0.1 });
    expect(Object.keys(seen!.questions)).toEqual(["a", "b"]);
    expect(nouls({ a: "statement a" }).a).toMatchObject({ type: "noul" });
    expect(JSON.stringify(seen!.questions.a)).toContain("statement a");
  });

  test("a missing answer is an error, never a silent zero", async () => {
    await expect(judgeStatements(async () => result({ a: 0.9 }), "x", { a: "s", b: "t" })).rejects.toThrow(/no noul answer for "b"/);
  });

  test("judged values thread into the existing expression language", () => {
    const vars = { "trigger.text": "x", ...judgeVars({ needs_review: 0.91, blocker: 0.05 }) };
    expect(evalCondition('judge.needs_review >= 0.8 && judge.blocker < 0.3', vars)).toBe(true);
    expect(evalCondition('judge.blocker >= 0.8', vars)).toBe(false);
    expect(() => evalCondition('judge.missing >= 0.8', vars)).toThrow(/unknown variable/);
  });

  test("a deciding left operand does not leave the right operand unparsed", () => {
    const vars = { a: 0.49, b: 0.02 };
    expect(evalCondition("a >= 0.6 && b < 0.3", vars)).toBe(false);
    expect(evalCondition("b < 0.3 || a >= 0.6", vars)).toBe(true);
    expect(evalCondition("a >= 0.6 || b < 0.3", vars)).toBe(true);
    expect(evalCondition("!(a >= 0.6) && b < 0.3 && a > 0", vars)).toBe(true);
  });

  test("state carries the trigger and the latest observed message", () => {
    expect(judgeState({ "trigger.text": "find X", "trigger.author_name": "ken" })).toEqual({ trigger: { author: "ken", text: "find X" } });
    expect(judgeState({ "trigger.text": "find X", "trigger.author_name": "ken", "latest.text": "done", "latest.author_name": "quill" }))
      .toMatchObject({ latest: { author: "quill", text: "done" } });
  });

  test("config needs both url and key", () => {
    expect(judgeConfigFromEnv({ FEZ_JUDGE_URL: "https://r/v1", FEZ_JUDGE_KEY: "k" })).toEqual({ url: "https://r/v1", key: "k" });
    expect(judgeConfigFromEnv({ FEZ_JUDGE_URL: "https://r/v1" })).toBeUndefined();
    expect(judgeConfigFromEnv({})).toBeUndefined();
  });
});
