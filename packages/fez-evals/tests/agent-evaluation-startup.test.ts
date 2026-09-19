import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Persona } from "@fezchat/protocol";

const fixture = vi.hoisted(() => ({ directory: "", tempRoot: "", missing: false, pi: false, profile: false, dropTool: false, calls: [] as { prompt: string; cwd: string; tools: string[] }[], logs: [] as string[], refreshed: 0 }));
vi.mock("node:os", async original => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fixture.directory, tmpdir: () => fixture.tempRoot || actual.tmpdir() } };
});
vi.mock("../../fez-acp/src/mcp-path.js", async original => ({
  ...await original<typeof import("../../fez-acp/src/mcp-path.js")>(),
  fezMcpLaunch: () => ({ launch: { command: process.execPath, args: ["/installed/fez-mcp.js"] }, tried: [] }),
  resolveNodeCommand: () => process.execPath,
}));
vi.mock("@fezchat/protocol", async original => {
  const actual = await original<typeof import("@fezchat/protocol")>();
  return { ...actual,
    registerBuiltinHarnesses: () => {},
    findPersona: async (): Promise<Persona> => ({ id: "configured", harness: "pi", aliases: [],
      systemPrompt: "Private persona instructions.", mcpServers: ["reader"], mcpSources: {}, skills: [], skillSources: {}, skillSettings: {},
      extra: { provider: "owner-provider", model: "owner-model", ...(fixture.profile ? { modelProfile: "owner-provider" } : {}), workdir: path.join(fixture.directory, "private-project"), repo: "private-repository" }, createdAt: "2026-09-10" }),
    findHarness: () => ({ id: "pi", command: process.execPath, aliases: [], detect: async () => { throw new Error("A preflight must not run a probe that can prepare credentials"); },
      invoke: async (prompt: string, cwd: string, _progress: unknown, tools: { name: string; env: { name: string; value: string }[] }[]) => {
        expect(process.env.FEZ_EVALUATION_ACTIVE).toBe("1");
        expect(tools.every(tool => tool.env.some(entry => entry.name === "FEZ_EVALUATION_ACTIVE" && entry.value === "1"))).toBe(true);
        expect(tools.every(tool => tool.env.some(entry => entry.name === "FEZ_AGENT_PERSONA" && entry.value === "configured"))).toBe(true);
        fixture.calls.push({ prompt, cwd, tools: tools.map(t => t.name) });
        if (fixture.pi) {
          expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi/settings.json"), "utf8"))).toMatchObject({ defaultProvider: "owner-provider", defaultModel: "owner-model" });
          const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(fixture.directory, ".pi/agent");
          expect(JSON.parse(fs.readFileSync(path.join(agentDir, "trust.json"), "utf8"))[fs.realpathSync(cwd)]).toBe(true);
        }
        return "The public script.";
      },
    }),
    findMcpServer: () => fixture.missing ? undefined : ({ name: "reader", command: process.execPath, args: [], env: [] }),
    resolveDeclaredSkills: () => fixture.missing ? { resolved: [], missing: [{ name: "reader" }] }
      : { resolved: [{ name: "reader", key: "reader", entry: { command: process.execPath } }], missing: [] },
    loadMcpServersFromSettings: () => {}, loadSettings: () => ({ mcpServers: {} }), skillsInstalled: () => [],
    withFreshOAuth: async (servers: unknown) => { fixture.refreshed++; return fixture.dropTool ? [] : servers; },
    resolveRelays: () => ["ws://evaluation.invalid"],
    RelayConnection: class { constructor() { throw new Error("Evaluation must not create a standing relay connection"); } },
  };
});

beforeEach(() => {
  vi.resetModules();
  fixture.tempRoot = "";
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), "fez-evaluation-startup-"));
  fixture.calls = []; fixture.logs = []; fixture.refreshed = 0; fixture.missing = false; fixture.pi = false; fixture.profile = false; fixture.dropTool = false;
  fs.mkdirSync(path.join(fixture.directory, ".fez/bin"), { recursive: true });
  fs.writeFileSync(path.join(fixture.directory, ".fez/bin/pi"), "do not execute", { mode: 0o755 });
  fs.mkdirSync(path.join(fixture.directory, ".pi/agent"), { recursive: true });
  fs.writeFileSync(path.join(fixture.directory, ".pi/agent/auth.json"), JSON.stringify({ "owner-provider": { type: "api_key", key: "test-provider-key" } }));
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  vi.stubEnv("FEZ_AGENT_PERSONA", "configured"); vi.stubEnv("FEZ_EVALUATION_CHECK", "1");
  vi.stubEnv("FEZ_EVALUATION_REQUEST", undefined); vi.stubEnv("FEZ_HIRE_TASK", "must not run");
  vi.spyOn(console, "log").mockImplementation((...args) => fixture.logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => fixture.logs.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(fixture.directory, { recursive: true, force: true }); });

it("preflights the actual agent without invoking, refreshing credentials, loading its private repository, or creating state", async () => {
  await import("../../fez-acp/src/agent.js");
  await vi.waitFor(() => expect(fixture.logs.some(line => line.startsWith("FEZ_EVALUATION_READY="))).toBe(true));
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.refreshed).toBe(0);
  expect(fs.readdirSync(fixture.directory)).toEqual([".fez", ".pi"]);
  expect(fs.readdirSync(path.join(fixture.directory, ".pi/agent"))).toEqual(["auth.json"]);
  const record = JSON.parse(fixture.logs.find(line => line.startsWith("FEZ_EVALUATION_READY="))!.split("=").slice(1).join("="));
  expect(record).toMatchObject({ ready: true, provider: "owner-provider", model: "owner-model", tools: ["fez", "reader"] });
  expect(JSON.stringify(record)).not.toContain("Private persona");
});

it("reports missing enabled tools without admitting or running the agent", async () => {
  fixture.missing = true;
  await import("../../fez-acp/src/agent.js");
  await vi.waitFor(() => expect(fixture.logs.some(line => line.startsWith("FEZ_EVALUATION_ERROR="))).toBe(true));
  expect(fixture.logs.find(line => line.startsWith("FEZ_EVALUATION_READY="))).toContain('"ready":false');
  expect(fixture.calls).toHaveLength(0);
  expect(fs.readdirSync(fixture.directory)).toEqual([".fez", ".pi"]);
});

it("uses the selected agent model profile during actual runtime preflight", async () => {
  fixture.profile = true;
  const directory = path.join(fixture.directory, ".fez/model-profiles/owner-provider/configured");
  fs.mkdirSync(directory, { recursive: true });
  const documents = {
    "profile.json": { provider: "owner-provider", model: "owner-model", persona: "configured" },
    "settings.json": { defaultProvider: "owner-provider", defaultModel: "owner-model", retry: { enabled: false } },
    "models.json": { providers: { "owner-provider": { apiKey: "private-profile-credential", models: [{ id: "owner-model" }] } } },
  };
  for (const [file, value] of Object.entries(documents)) fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  await import("../../fez-acp/src/agent.js");
  await vi.waitFor(() => expect(fixture.logs.some(line => line.startsWith("FEZ_EVALUATION_READY="))).toBe(true));
  expect(process.env.PI_CODING_AGENT_DIR).toBe(directory);
  expect(fixture.logs.join("\n")).not.toContain("private-profile-credential");
  expect(fixture.calls).toHaveLength(0);
});

it.each([false, true])("runs the owner's Pi model/tools through an aliased directory (isolated profile: %s)", async isolated => {
  fixture.pi = true;
  const actual = path.join(fixture.directory, "actual-temp");
  fs.mkdirSync(actual);
  fixture.tempRoot = path.join(fixture.directory, "temp-alias");
  fs.symlinkSync(actual, fixture.tempRoot, "dir");
  const piDir = isolated ? path.join(fixture.directory, "isolated-pi") : path.join(fixture.directory, ".pi/agent");
  if (isolated) {
    fs.mkdirSync(piDir);
    fs.copyFileSync(path.join(fixture.directory, ".pi/agent/auth.json"), path.join(piDir, "auth.json"));
    vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
  }
  vi.stubEnv("FEZ_EVALUATION_CHECK", "");
  const file = path.join(fixture.directory, "request.json");
  fs.writeFileSync(file, JSON.stringify({ prompt: "Write a public script.", maxCostUsd: 0.01, timeoutMs: 1000 }));
  vi.stubEnv("FEZ_EVALUATION_REQUEST", file);
  await import("../../fez-acp/src/agent.js");
  await vi.waitFor(() => expect(fixture.logs.some(line => line.startsWith("FEZ_EVALUATION_RESULT="))).toBe(true));
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({ tools: ["reader", "fez"] });
  expect(fixture.calls[0].prompt).toContain("Private persona instructions.");
  expect(fs.existsSync(fixture.calls[0].cwd)).toBe(false);
  expect(fs.existsSync(path.join(fixture.directory, "private-project"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(piDir, "trust.json"), "utf8"))).toEqual({});
});

it("does not invoke after credential refresh drops an admitted tool", async () => {
  fixture.dropTool = true;
  vi.stubEnv("FEZ_EVALUATION_CHECK", "");
  const file = path.join(fixture.directory, "request.json");
  fs.writeFileSync(file, JSON.stringify({ prompt: "Write a public script.", maxCostUsd: 0.01, timeoutMs: 1000 }));
  vi.stubEnv("FEZ_EVALUATION_REQUEST", file);
  await import("../../fez-acp/src/agent.js");
  await vi.waitFor(() => expect(fixture.logs.some(line => line.includes("enabled tools changed"))).toBe(true));
  expect(fixture.calls).toEqual([]);
  expect(fs.existsSync(path.join(fixture.directory, "private-project"))).toBe(false);
  expect(process.env.FEZ_EVALUATION_ACTIVE).not.toBe("1");
});
