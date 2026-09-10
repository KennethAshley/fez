import { expect, it, vi } from "vitest";
import { TerminalInputs } from "../../../src/cli/agent-input.js";
import { inputForm } from "../../fez-client/src/agent-input.js";

it("collects each terminal answer and requires explicit submission", async () => {
  const print = vi.fn(), submit = vi.fn().mockResolvedValue(undefined);
  const ui = new TerminalInputs(print);
  ui.add("request", "quill", inputForm({ mode: "form", message: "Choose", requestedSchema: { properties: {
    one: { type: "string", enum: ["small", "large"] },
    two: { type: "array", items: { type: "string", enum: ["search", "filters"] } },
    three: { type: "string", title: "Other" },
  } } }), submit);
  await ui.handle("/answer 1");
  await ui.handle("2");
  await ui.handle("1,2");
  await ui.handle("/tmp/project");
  expect(submit).not.toHaveBeenCalled();
  await ui.handle("/submit");
  expect(submit).toHaveBeenCalledWith({ action: "accept", content: { one: "large", two: ["search", "filters"], three: "/tmp/project" } });
  expect(await ui.handle("ordinary chat")).toBe(false);
});
