import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MAX_CHAIN_DEPTH } from "@fezchat/protocol";
import { SummonEngine, type SummonHost, type SummonEvent } from "../../../src/agent/summon.js";

/**
 * Chain-depth registry gate. The agent-to-agent loop brake works only if
 * every hop agrees on the same cap: the replying agent refuses past it
 * (fez-acp agent.ts), the summoner refuses to WAKE anyone past it
 * (src/agent/summon.ts), and the orchestrator, workflows, and TUI all
 * count with the same ruler.
 *
 * It used to live as the literal `5` copy-pasted into five files with
 * nothing tying them together — the same drift shape kinds-registry.test.ts
 * exists to prevent, and a worse failure: a summoner with a HIGHER cap than
 * the agents wakes a persona into a chain the running agents have already
 * refused to continue, which reads as an agent that spawns and says nothing.
 */

const REPO = path.resolve(__dirname, "../../..");

const SITES = [
  "packages/fez-acp/src/agent.ts",
  "packages/fez-orchestrator/src/orchestrator.ts",
  "packages/fez-workflows/src/workflows.ts",
  "src/cli/tui.ts",
  "src/agent/summon.ts",
];

describe("chain-depth registry", () => {
  it("the cap is exported from the protocol registry", () => {
    expect(MAX_CHAIN_DEPTH).toBe(5);
  });

  it("no consumer redeclares the cap as a literal", () => {
    const offenders = SITES.filter((site) =>
      /(?:const|let)\s+MAX_CHAIN_DEPTH\s*(?::\s*number\s*)?=\s*\d/.test(
        fs.readFileSync(path.join(REPO, site), "utf8")
      )
    );
    expect(offenders).toEqual([]);
  });

  it("every consumer names the shared constant", () => {
    const missing = SITES.filter(
      (site) => !/MAX_CHAIN_DEPTH/.test(fs.readFileSync(path.join(REPO, site), "utf8"))
    );
    expect(missing).toEqual([]);
  });
});

/**
 * The summoner's cap is a default parameter, so it can drift from the
 * agents' cap without any import breaking. Pin it behaviorally: one hop
 * below the cap still wakes a sleeping agent, and the cap itself never does.
 */
describe("SummonEngine honors the shared cap", () => {
  const OWNER = "aa".repeat(32);

  function makeHost() {
    const spawned: string[] = [];
    const host: SummonHost = {
      ownerPubkey: OWNER,
      personaExists: (n) => n === "scout",
      personaPubkey: async () => undefined,
      agentAlive: () => false,
      registryEntry: () => undefined,
      spawn: async (persona) => { spawned.push(persona); },
      restart: async (persona) => { spawned.push(persona); },
      query: async () => [],
      publish: async () => {},
      announceTimeout: () => {},
    };
    return { host, spawned };
  }

  const at = (depth: number): SummonEvent => ({
    kind: 47103,
    pubkey: OWNER,
    content: "@scout go",
    tags: [["h", "chan1"], ["depth", String(depth)]],
  });

  it("summons one hop below the cap", async () => {
    const { host, spawned } = makeHost();
    await new SummonEngine(host).handleEvent(at(MAX_CHAIN_DEPTH - 1));
    expect(spawned).toEqual(["scout"]);
  });

  it("refuses at the cap", async () => {
    const { host, spawned } = makeHost();
    await new SummonEngine(host).handleEvent(at(MAX_CHAIN_DEPTH));
    expect(spawned).toEqual([]);
  });
});
