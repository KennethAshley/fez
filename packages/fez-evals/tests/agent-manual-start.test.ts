// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import AgentProfile from "../../fez-desktop/src/AgentProfile";
import { clearWaking } from "../../fez-desktop/src/waking";

const native = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>());
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: native }));
vi.mock("../../fez-desktop/src/config-store", () => ({ useConfig: () => ({ skills: {} }) }));
vi.mock("../../fez-desktop/src/relay", () => ({ relaySet: () => ["wss://example.test"] }));

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { native.mockReset(); clearWaking("steph"); });

async function profile(alive: boolean, decline = false) {
  native.mockImplementation(async (command, args) => {
    switch (command) {
      case "read_persona": return "harness: pi\nmcpServers: [web, ditto]";
      case "list_installed_skills": return "[]";
      case "agent_alive": return args?.bin === "fez-agent" ? alive : true;
      case "persona_mtime": return 100;
      case "spawned_agents": return [{ persona: "steph", bin: "fez-miner", channels: [], spawned_at: 999 }, { persona: "steph", channels: ["general"], repo: "project", line: "main", spawned_at: 90 }];
      case "kill_agent": return false;
      case "spawn_agent":
        if (decline || args?.manual !== true) return 0;
        alive = true;
        return 42;
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
  const div = document.createElement("div"); document.body.append(div);
  const root = createRoot(div);
  await React.act(async () => root.render(React.createElement(AgentProfile, { name: "steph", owner: "a".repeat(64), onEdit: () => {} })));
  return { div, close: async () => { await React.act(async () => root.unmount()); div.remove(); } };
}

it.each([false, true])("an explicit start/restart delegates replacement to the native manual path (alive: %s)", async (alive) => {
  const p = await profile(alive);
  try {
    const button = [...p.div.querySelectorAll("button")].find(b => b.textContent === (alive ? "restart" : "start"))!;
    await React.act(async () => button.click());
    expect(native).toHaveBeenCalledWith("spawn_agent", {
      persona: "steph", channels: ["general"], owner: "a".repeat(64),
      relays: "wss://example.test", repo: "project", baseBranch: "main", manual: true,
    });
    expect(native.mock.calls.some(([command]) => command === "kill_agent")).toBe(false);
    expect(p.div.textContent).toContain("waking");
    expect(p.div.textContent).not.toContain("asleep");
    expect(p.div.textContent).not.toContain("will pick this up");
  } finally { await p.close(); }
});

it("reports a declined spawn instead of promising a sentinel will pick it up", async () => {
  const p = await profile(false, true);
  try {
    await React.act(async () => [...p.div.querySelectorAll("button")].find(b => b.textContent === "start")!.click());
    expect(p.div.textContent).toContain("The agent did not start");
    expect(p.div.textContent).not.toContain("will pick this up");
  } finally { await p.close(); }
});
