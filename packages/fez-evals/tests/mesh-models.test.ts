import { expect, it } from "vitest";
import { MODEL_PROVIDER, modelList, prepareCheck, type MeshState } from "../../fez-mesh/src/state.js";

// What `fez-mesh models --json` prints and `fez-mesh prepare` enforces. The
// desktop reads both through the manifest-declared provider, so the shape
// here IS the model-picker contract — no GUI code involved.
const ready: MeshState = { configured: true, provider: MODEL_PROVIDER, model: "fez-mini-qwen3-4b", label: "Mac mini",
  machine: "ken@kenmini.local", status: "ready", callersVerified: true, callers: [] };

it("lists the one shared model with a friendly name and the machine it runs on", () => {
  expect(modelList(ready)).toEqual([{ id: "fez-mini-qwen3-4b", label: "Qwen3 4B · Mac mini", status: "ready",
    detail: "Model runs on Mac mini. Tools run on this Mac. Saving grants this agent access to Mac mini." }]);
  const offline = modelList({ ...ready, status: "offline", detail: "Mini or signed gateway is unavailable" });
  expect(offline[0].status).toBe("offline");
  expect(offline[0].detail).toContain("Mini or signed gateway is unavailable.");
});

it("lists nothing when no machine is configured", () => {
  expect(modelList({ ...ready, configured: false, model: "", machine: "" })).toEqual([]);
});

it("names a box that is not a Mac mini by its label, never by hardcoded prose", () => {
  const [model] = modelList({ ...ready, label: "Studio in the loft", model: "some-other-model" });
  expect(model.label).toBe("some-other-model · Studio in the loft");
  expect(model.detail).not.toContain("Mini");
});

it("refuses to prepare an agent unless the machine is ready and the model is the one on offer", () => {
  expect(prepareCheck(ready, "fez-mini-qwen3-4b")).toBeUndefined();
  expect(prepareCheck({ ...ready, status: "offline" }, "fez-mini-qwen3-4b")).toBe("Start Mac mini in Settings → Shared Models, then save again.");
  expect(prepareCheck({ ...ready, configured: false }, "fez-mini-qwen3-4b")).toContain("Start Mac mini");
  expect(prepareCheck(ready, "changed-model")).toBe("The shared model changed. Select it again before saving.");
});
