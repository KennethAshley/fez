import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { setSkillPackOnAgent } from "../src/SkillsView";

const mocked = invoke as ReturnType<typeof vi.fn>;
const PACK = [
  { id: "ponytail", name: "ponytail" },
  { id: "review-mode", name: "review" },
];

describe("setSkillPackOnAgent", () => {
  beforeEach(() => mocked.mockReset());

  it("attaches every pack skill by id, one write, mcpServers untouched", async () => {
    mocked.mockResolvedValueOnce("---\nharness: pi\nmcpServers: [wallet]\n---\nBody.");
    mocked.mockResolvedValueOnce(undefined); // update_persona
    expect(await setSkillPackOnAgent("deployer", PACK, true)).toBe("changed");
    const [cmd, args] = mocked.mock.calls[1] as [string, { name: string; content: string }];
    expect(cmd).toBe("update_persona");
    expect(args.content).toContain("skills: [ponytail, review-mode]");
    expect(args.content).toContain("mcpServers: [wallet]");
  });

  it("detaches a skill declared under its display name, reports already when nothing to do", async () => {
    // Declared under the display name, not the id — the dual rule must still find and remove it.
    mocked.mockResolvedValueOnce("---\nharness: pi\nskills: [ponytail, review]\n---\nBody.");
    mocked.mockResolvedValueOnce(undefined);
    expect(await setSkillPackOnAgent("deployer", PACK, false)).toBe("changed");
    const [, args] = mocked.mock.calls[1] as [string, { content: string }];
    expect(args.content).not.toContain("skills: [");

    mocked.mockReset();
    mocked.mockResolvedValueOnce("---\nharness: pi\n---\nBody.");
    expect(await setSkillPackOnAgent("deployer", PACK, false)).toBe("already");
    expect(mocked.mock.calls.length).toBe(1); // read only, no write
  });
});
