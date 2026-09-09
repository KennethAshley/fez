import { describe, expect, it } from "vitest";
import {
  containerName, resolveEnv, envFileContent, dockerRunArgs, dockerRegisterArgs,
} from "../src/container-runner.js";
import type { MinerContainer } from "@fezchat/extension-api";

const C: MinerContainer = {
  image: "ghcr.io/fezchat/gradients-miner@sha256:abc",
  env: { WALLET_NAME: "{walletName}", NETUID: "56" },
  ports: [{ internal: 7999 }],
  mountKeys: true,
};
const PORTS = [{ externalIp: "1.2.3.4", externalPort: 7999, internalPort: 7999 }];

describe("container-runner builders", () => {
  it("names containers deterministically — stop can always find them", () => {
    expect(containerName(56, "gauss")).toBe("fez-56-gauss");
  });

  it("resolves {key} templates from config and passes literals through", () => {
    expect(resolveEnv(C.env, { walletName: "default" }))
      .toEqual({ WALLET_NAME: "default", NETUID: "56" });
  });

  it("env file is KEY=VALUE lines with a trailing newline", () => {
    expect(envFileContent({ A: "1", B: "two" })).toBe("A=1\nB=two\n");
  });

  it("run args: detached, restart policy, name, env-file, port publishes, ro key mount, image", () => {
    expect(dockerRunArgs(C, "fez-56-gauss", "/root/fez-mining/56-gauss/.env", PORTS)).toEqual([
      "run", "-d", "--name", "fez-56-gauss", "--restart", "unless-stopped",
      "--env-file", "/root/fez-mining/56-gauss/.env",
      "-p", "7999:7999",
      "-v", "/root/.bittensor:/root/.bittensor:ro",
      "ghcr.io/fezchat/gradients-miner@sha256:abc",
    ]);
  });

  it("a declared internal port with no machine mapping publishes identity", () => {
    const args = dockerRunArgs(C, "n", "/e", []);
    expect(args).toContain("7999:7999");
  });

  it("register args: --rm one-shot in the same image with the command", () => {
    const withReg: MinerContainer = { ...C, register: { command: ["fiber-post-ip", "--netuid", "56"] } };
    expect(dockerRegisterArgs(withReg, "/e")).toEqual([
      "run", "--rm", "--env-file", "/e",
      "-v", "/root/.bittensor:/root/.bittensor:ro",
      "ghcr.io/fezchat/gradients-miner@sha256:abc",
      "fiber-post-ip", "--netuid", "56",
    ]);
  });

  it("no mountKeys ⇒ no volume flag", () => {
    const bare: MinerContainer = { image: "img@sha256:x" };
    expect(dockerRunArgs(bare, "n", "/e", []).join(" ")).not.toContain("-v");
  });
});
