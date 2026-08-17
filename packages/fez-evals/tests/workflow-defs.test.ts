import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDefs, resolveTemplate } from "../../fez-workflows/dist/defs.js";

/**
 * Workflow vocabulary gate (GAPS item 14): the expanded step set loads,
 * the SEC-006 exfiltration fence holds (webhook URLs must be static and
 * https/localhost), step ids are unique, and template resolution covers
 * step outputs.
 */

function loadYaml(yamlText: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wf-"));
  fs.writeFileSync(path.join(dir, "test.yaml"), yamlText);
  return loadDefs(dir);
}

const base = `
name: t
channel: general
trigger: { on: message, filter: "deploy" }
`;

describe("workflow definition vocabulary", () => {
  test("all six step types validate", () => {
    const defs = loadYaml(`${base}
steps:
  - say: "starting {{trigger.author_name}}"
    id: kickoff
  - react: { emoji: "🚀" }
  - delay: 5s
  - dm: { to: owner, message: "run {{steps.kickoff.output}} underway" }
  - webhook: { url: "https://example.com/hook", body: '{"msg":"{{trigger.text}}"}', timeout: 5s, id: hook }
  - wait_reaction: { emoji: "👍", from: owner, timeout: 1h }
`);
    expect(defs).toHaveLength(1);
    expect(defs[0].steps).toHaveLength(6);
  });

  test("webhook url templating is rejected — channel text can't steer destinations", () => {
    expect(() =>
      loadYaml(`${base}
steps:
  - webhook: { url: "https://example.com/{{trigger.text}}" }
`)
    ).toThrow(/static|template/i);
  });

  test("non-https webhook urls rejected (localhost allowed)", () => {
    expect(() =>
      loadYaml(`${base}
steps:
  - webhook: { url: "http://evil.example.com/x" }
`)
    ).toThrow(/https/);
    expect(
      loadYaml(`${base}
steps:
  - webhook: { url: "http://localhost:9999/dev" }
`)
    ).toHaveLength(1);
  });

  test("duplicate step ids rejected; bad delay rejected; unknown step shape rejected", () => {
    expect(() =>
      loadYaml(`${base}
steps:
  - say: "a"
    id: x
  - say: "b"
    id: x
`)
    ).toThrow(/duplicate step id/);
    expect(() =>
      loadYaml(`${base}
steps:
  - delay: "0s"
`)
    ).toThrow(/positive/);
    expect(() =>
      loadYaml(`${base}
steps:
  - frobnicate: yes
`)
    ).toThrow(/must be a/);
  });

  test("step outputs resolve through templates; unknown vars stay visible", () => {
    const vars = { "steps.kickoff.output": "ev123", "trigger.text": "deploy now", approved_by: "ken" };
    expect(resolveTemplate("run {{steps.kickoff.output}} ok by {{approved_by}}", vars)).toBe("run ev123 ok by ken");
    expect(resolveTemplate("missing {{steps.nope.output}}", vars)).toBe("missing {{steps.nope.output}}");
  });
});
