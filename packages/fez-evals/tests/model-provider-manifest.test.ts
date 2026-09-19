import { afterEach, expect, it, vi } from "vitest";
import {
  parseModelProviderManifest, manifestModelProvider, registerModelProvider, snapshotModelProviders,
} from "../../fez-desktop/src/model-providers";

// A manifest-declared provider: the desktop drives the extension's own bin
// through the processes broker, so an isolated GUI part never has to run
// code in the host webview to appear in the model picker.
const decl = { id: "mini", label: "Shared Models", bin: "fez-mesh", list: ["models", "--json"],
  prepare: ["prepare", "--name", "{persona}", "--model", "{model}"] };

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

it("parses a valid declaration and treats an absent one as no provider", () => {
  expect(parseModelProviderManifest(undefined)).toBeUndefined();
  expect(parseModelProviderManifest(decl)).toEqual(decl);
});

it.each([
  ["no bin", { ...decl, bin: undefined }],
  ["bad id", { ...decl, id: "Mini Provider" }],
  ["control char in label", { ...decl, label: "Shared" + String.fromCharCode(7) + "Models" }],
  ["non-string arg", { ...decl, list: ["models", 1] }],
  ["prepare without {persona}", { ...decl, prepare: ["prepare", "--model", "{model}"] }],
  ["prepare without {model}", { ...decl, prepare: ["prepare", "--name", "{persona}"] }],
  ["not an object", "fez-mesh"],
])("rejects a malformed declaration: %s", (_label, value) => {
  expect(() => parseModelProviderManifest(value)).toThrow();
});

it("namespaces the id under the extension and lists models by running the declared bin", async () => {
  const run = vi.fn(async () => ({ code: 0, stderr: "", stdout: JSON.stringify([{ id: "fez-mini-qwen3-4b", label: "Qwen3 4B · Mac mini", status: "ready" }]) }));
  const provider = manifestModelProvider("mesh", decl, run);
  expect(provider.id).toBe("ext-mesh-mini");
  expect(provider.label).toBe("Shared Models");
  await expect(provider.listModels()).resolves.toEqual([{ id: "fez-mini-qwen3-4b", label: "Qwen3 4B · Mac mini", status: "ready" }]);
  expect(run).toHaveBeenCalledWith("fez-mesh", ["models", "--json"]);
  restore = snapshotModelProviders();
  expect(() => registerModelProvider("mesh", provider)).not.toThrow();
});

it("surfaces the bin's stderr when listing fails and refuses output that is not a list", async () => {
  const failing = manifestModelProvider("mesh", decl, async () => ({ code: 1, stdout: "", stderr: "Mini has not been configured\n" }));
  await expect(failing.listModels()).rejects.toThrow("Mini has not been configured");
  const garbage = manifestModelProvider("mesh", decl, async () => ({ code: 0, stdout: "{\"ok\":true}", stderr: "" }));
  await expect(garbage.listModels()).rejects.toThrow();
});

it("prepares by substituting persona and model into the declared args, validating both first", async () => {
  const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const provider = manifestModelProvider("mesh", decl, run);
  await provider.prepare("scout", "fez-mini-qwen3-4b");
  expect(run).toHaveBeenCalledWith("fez-mesh", ["prepare", "--name", "scout", "--model", "fez-mini-qwen3-4b"]);
  run.mockClear();
  await expect(provider.prepare("Not A Persona", "fez-mini-qwen3-4b")).rejects.toThrow();
  await expect(provider.prepare("scout", "bad" + String.fromCharCode(0) + "model")).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  const refused = manifestModelProvider("mesh", decl, async () => ({ code: 2, stdout: "", stderr: "Start the Mini in Settings → Shared Models, then save again." }));
  await expect(refused.prepare("scout", "fez-mini-qwen3-4b")).rejects.toThrow("Start the Mini");
});
