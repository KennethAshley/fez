import { describe, expect, test } from "vitest";
import { STYLE_ONLY_AT, gateOwnerQuestion, pickFor, presentationQuestion } from "../../fez-mcp/src/owner-gate.js";
import type { JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

const noul = (v: number): JudgeResult => ({ model: "jev-1.13.0", inputTokens: 1, outputTokens: 1, answers: { style: { type: "noul", noul: v } } });
const options = [{ label: "Technical" }, { label: "Concise", recommended: true }, { label: "Actionable" }];

describe("owner-question gate", () => {
  test("a presentation question is decided by the agent with its own recommendation", async () => {
    let seen: unknown;
    const v = await gateOwnerQuestion(async (state) => { seen = state; return noul(0.93); }, "What tone would you like?", options);
    expect(v).toMatchObject({ outcome: "self", pick: "Concise", value: 0.93 });
    expect(JSON.stringify(seen)).toContain("Concise (recommended)");
    expect(presentationQuestion().style.type).toBe("noul");
  });

  test("a real owner decision is asked", async () => {
    const v = await gateOwnerQuestion(async () => noul(0.02), "Deploy now or wait for review?", [{ label: "Deploy" }, { label: "Wait", recommended: true }]);
    expect(v.outcome).toBe("ask");
  });

  test("the bar is inclusive and sits at 0.8", async () => {
    expect(STYLE_ONLY_AT).toBe(0.8);
    expect((await gateOwnerQuestion(async () => noul(0.8), "q", options)).outcome).toBe("self");
    expect((await gateOwnerQuestion(async () => noul(0.79), "q", options)).outcome).toBe("ask");
  });

  test("fails open: judge error asks as before", async () => {
    const v = await gateOwnerQuestion(async () => { throw new Error("Judge HTTP 503"); }, "q", options);
    expect(v.outcome).toBe("ask");
    expect(v.error).toContain("503");
  });

  test("pick is the recommended option, else the first", () => {
    expect(pickFor(options)).toBe("Concise");
    expect(pickFor([{ label: "A" }, { label: "B" }])).toBe("A");
  });
});
