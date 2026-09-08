import { describe, expect, it } from "vitest";
import type { MachinePort, MinerContext } from "@fezchat/extension-api";
import miners from "../src/miner-part.js";

describe("gradients descriptor", () => {
  it("declares SN56 with a public-endpoint requirement, no GPU floor", () => {
    expect(miners).toHaveLength(1);
    expect(miners[0]).toMatchObject({
      netuid: 56,
      name: "gradients",
      requirements: { alwaysOn: true, publicEndpoint: true },
    });
    expect(miners[0].requirements?.gpu).toBeUndefined();
    expect(typeof miners[0].start).toBe("function");
  });

  it("declares its config schema — wallet/network/stake/refresh, no LLM provider or secret", () => {
    const keys = miners[0].config?.map((f) => f.key) ?? [];
    expect(keys).toEqual(["walletName", "subtensorNetwork", "minStakeThreshold", "refreshNodes"]);
    expect(miners[0].config?.some((f) => f.type === "secret")).toBe(false);
  });
});

function fakeCtx(ports: MachinePort[], execCalls: string[], config: Record<string, string | number | boolean> = {}): MinerContext {
  return {
    workDir: "/tmp/gradients-test",
    persona: "p",
    hotkey: "5F",
    netuid: 56,
    env: {},
    config,
    log: () => {},
    machine: {
      kind: "lium",
      ports,
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      },
      copy: async () => {},
    },
  };
}

// I2: register() must fail loudly, never fall back to ports[0] — posting
// the wrong port (e.g. SSH) to the metagraph is worse than refusing.
describe("gradients register() port selection", () => {
  it("throws when no port maps to internal 7999, even with an unrelated ports[0]", async () => {
    const execCalls: string[] = [];
    const ctx = fakeCtx([{ externalIp: "1.2.3.4", externalPort: 20001, internalPort: 22 }], execCalls);
    await expect(miners[0].register!(ctx)).rejects.toThrow(/7999/);
    expect(execCalls).toHaveLength(0);
  });

  it("posts the internal:7999 mapping specifically, not ports[0]", async () => {
    const execCalls: string[] = [];
    const ctx = fakeCtx(
      [
        { externalIp: "1.2.3.4", externalPort: 20001, internalPort: 22 }, // ssh, ports[0]
        { externalIp: "1.2.3.4", externalPort: 20002, internalPort: 7999 },
      ],
      execCalls
    );
    await miners[0].register!(ctx);
    expect(execCalls[0]).toContain("--external_port 20002");
    expect(execCalls[0]).toContain("--external_ip 1.2.3.4");
  });

  it("maps ctx.config.walletName/subtensorNetwork into fiber-post-ip instead of the old hardcoded default/finney", async () => {
    const execCalls: string[] = [];
    const ctx = fakeCtx(
      [{ externalIp: "1.2.3.4", externalPort: 20002, internalPort: 7999 }],
      execCalls,
      { walletName: "quill", subtensorNetwork: "test" }
    );
    await miners[0].register!(ctx);
    expect(execCalls[0]).toContain("--wallet.name quill");
    expect(execCalls[0]).toContain("--subtensor.network test");
  });
});
