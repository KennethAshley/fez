import { expect, it } from "vitest";
import { reflectionConfig } from "../../fez-acp/src/reflection.js";
import { parseFrontmatter, validatePersonaFile } from "../../../src/identity/personas.js";

it("keeps reflection opt-in and lets the environment disable persona defaults", () => {
  expect(reflectionConfig({}, {})).toBeUndefined();
  expect(reflectionConfig({ reflectionPrompt: "Check docs" }, {})).toBeUndefined();
  expect(reflectionConfig({ reflectionEvery: "1h" }, { FEZ_AGENT_REFLECTION_EVERY: "off" })).toBeUndefined();
  expect(reflectionConfig({ reflectionEvery: "0" }, {})).toBeUndefined();
});

it("reads valid persona settings and environment overrides", () => {
  const text = "---\nharness: pi\ndescription: maintain docs\nreflectionEvery: 30m\nreflectionPrompt: Keep docs accurate.\n---\nYou maintain docs.";
  expect(validatePersonaFile(text, "docs").warnings).toEqual([]);
  expect(reflectionConfig(parseFrontmatter(text).extra, {})).toEqual({ everyMs: 1_800_000, prompt: "Keep docs accurate." });
  expect(reflectionConfig(parseFrontmatter(text).extra, { FEZ_AGENT_REFLECTION_EVERY: "2h", FEZ_AGENT_REFLECTION_PROMPT: "Check unfinished tasks." }))
    .toEqual({ everyMs: 7_200_000, prompt: "Check unfinished tasks." });
  expect(reflectionConfig({ reflectionEvery: "1d" }, {})?.everyMs).toBe(86_400_000);
});

it.each(["-1m", "0m", "1s", "59s", "often", "30d", "999999999999999999999h"])("rejects unsafe timer interval %s", reflectionEvery => {
  expect(() => reflectionConfig({ reflectionEvery }, {})).toThrow(/reflectionEvery/);
});

it("rejects an explicitly empty responsibility", () => {
  expect(() => reflectionConfig({ reflectionEvery: "1m", reflectionPrompt: " " }, {})).toThrow(/reflectionPrompt/);
});
