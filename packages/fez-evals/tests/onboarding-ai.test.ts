import { afterEach, expect, it, vi } from "vitest";
import { readiness } from "../../fez-desktop/src/welcome.js";
import { findHarness, registerBuiltinHarnesses } from "../../../src/agent/harness.js";
import { withPersonaBrain } from "../../fez-desktop/src/welcome-core.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

function setup(md: string, keyed: string[] = []) {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  invoke.mockImplementation(async (cmd: string, args?: { provider?: string }) => {
    if (cmd === "read_persona") return md;
    if (cmd === "detect_harnesses") return JSON.stringify({ pi: true, "claude-code": true, codex: true });
    if (cmd === "claude_brain_status" || cmd === "codex_brain_status") return JSON.stringify({ installed: true, authed: true, adapterReady: true });
    if (cmd === "provider_key_present") return keyed.includes(args?.provider ?? "");
    throw new Error(`Unexpected command: ${cmd}`);
  });
}

it("does not call an unconfigured built-in agent ready because Claude is signed in", async () => {
  setup("---\nharness: pi\n---\n");
  expect((await readiness()).authed).toBe(false);
});

it("checks the selected provider, including providers beyond the original four", async () => {
  setup("---\nharness: pi\nprovider: engy\nmodel: chosen-model\n---\n", ["engy"]);
  expect((await readiness()).authed).toBe(true);
  setup("---\nharness: pi\nprovider: openai\nmodel: chosen-model\n---\n", ["engy"]);
  expect((await readiness()).authed).toBe(false);
});

it("uses Codex readiness for a Codex persona without requiring a Fez provider", async () => {
  setup("---\nharness: codex\n---\n");
  expect((await readiness()).authed).toBe(true);
  expect(invoke.mock.calls.some(([cmd]) => cmd === "codex_brain_status")).toBe(true);
  expect(invoke.mock.calls.some(([cmd]) => cmd === "provider_key_present")).toBe(false);
});

it("registers Codex on the shared ACP launch path", () => {
  registerBuiltinHarnesses();
  expect(findHarness("codex")).toMatchObject({ id: "codex" });
  expect(findHarness("codex")?.command).toMatch(/codex-acp$/);
  expect(findHarness("codex")?.openSession).toBeTypeOf("function");
});

it("reconnecting AI changes only brain fields and preserves the persona's instructions", () => {
  const md = "---\nharness: pi\nprovider: openai\nmodel: old\neffort: high\nskills: [git]\n---\n\nCustom instructions.\n";
  expect(withPersonaBrain(md, { harness: "codex" })).toBe("---\nharness: codex\nskills: [git]\n---\n\nCustom instructions.\n");
});
