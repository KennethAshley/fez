import { describe, expect, it } from "vitest";
import {
  containerName, resolveEnv, envFileContent, dockerRunArgs, dockerRegisterArgs,
  ensureDocker, runContainerMiner, stopContainerMiner,
} from "../src/container-runner.js";
import type { MinerContainer, MinerMachine } from "@fezchat/extension-api";

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

// Scripted machine: responses keyed by the first docker verb in the command.
const machineOf = (script: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
  const cmds: string[] = [];
  const machine: MinerMachine = {
    kind: "ssh",
    ports: [{ externalIp: "1.2.3.4", externalPort: 7999, internalPort: 7999 }],
    exec: async (cmd) => {
      cmds.push(cmd);
      const verb = Object.keys(script).find((k) => cmd.includes(k));
      const r = verb ? script[verb] : { code: 0 };
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    copy: async () => {},
  };
  return { machine, cmds };
};

describe("container-runner orchestration", () => {
  it("ensureDocker passes when docker answers, throws a named fix when absent", async () => {
    const ok = machineOf({ "docker -v": { code: 0, stdout: "Docker version 27" } });
    await expect(ensureDocker(ok.machine, () => {})).resolves.toBeUndefined();
    const missing = machineOf({ "docker -v": { code: 127, stderr: "docker: command not found" } });
    await expect(ensureDocker(missing.machine, () => {})).rejects.toThrow(/no Docker/);
  });

  it("run sequence: pull → register (once) → env-file 600 → run → wait; resolves with the exit code", async () => {
    const { machine, cmds } = machineOf({
      "docker pull": { code: 0 },
      "docker run --rm": { code: 0 },
      "docker run -d": { code: 0, stdout: "abc123\n" },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    const code = await runContainerMiner({
      machine,
      container: { image: "img@sha256:x", env: { A: "{a}" }, register: { command: ["post-ip"] }, mountKeys: true },
      netuid: 56, persona: "gauss", workDir: "/root/fez-mining/56-gauss",
      config: { a: "1" }, registered: false, log: () => {},
    });
    expect(code).toBe(0);
    const joined = cmds.join(" || ");
    expect(joined).toContain("docker pull 'img@sha256:x'");
    expect(joined).toContain("chmod 600");
    expect(cmds.findIndex((c) => c.includes("docker run --rm")))
      .toBeLessThan(cmds.findIndex((c) => c.includes("docker run -d")));
    expect(joined).toContain("docker wait 'fez-56-gauss'");
  });

  it("registered: true skips the one-shot", async () => {
    const { machine, cmds } = machineOf({
      "docker pull": { code: 0 },
      "docker run -d": { code: 0 },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    await runContainerMiner({
      machine, container: { image: "i@sha256:x", register: { command: ["x"] } },
      netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
    });
    expect(cmds.some((c) => c.includes("docker run --rm"))).toBe(false);
  });

  it("onRegistered fires right after a successful register — a later run/wait failure must never undo it", async () => {
    const { machine } = machineOf({
      "docker pull": { code: 0 },
      "docker run --rm": { code: 0 },
      "docker run -d": { code: 1, stderr: "boom" },
    });
    let fired = false;
    await expect(
      runContainerMiner({
        machine, container: { image: "i@sha256:x", register: { command: ["post-ip"] } },
        netuid: 1, persona: "p", workDir: "/w", config: {}, registered: false, log: () => {},
        onRegistered: async () => { fired = true; },
      })
    ).rejects.toThrow(/docker run exited/);
    expect(fired).toBe(true);
  });

  it("onRegistered does not fire when registered: true", async () => {
    const { machine } = machineOf({
      "docker pull": { code: 0 },
      "docker run -d": { code: 0 },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    let fired = false;
    await runContainerMiner({
      machine, container: { image: "i@sha256:x", register: { command: ["x"] } },
      netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
      onRegistered: async () => { fired = true; },
    });
    expect(fired).toBe(false);
  });

  it("onRegistered does not fire when the descriptor has no register command", async () => {
    const { machine } = machineOf({
      "docker pull": { code: 0 },
      "docker run -d": { code: 0 },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    let fired = false;
    await runContainerMiner({
      machine, container: { image: "i@sha256:x" },
      netuid: 1, persona: "p", workDir: "/w", config: {}, registered: false, log: () => {},
      onRegistered: async () => { fired = true; },
    });
    expect(fired).toBe(false);
  });

  it("stale container is removed before a fresh run (restart-safe)", async () => {
    const { machine, cmds } = machineOf({
      "docker pull": { code: 0 },
      "docker rm -f": { code: 0 },
      "docker run -d": { code: 0 },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    await runContainerMiner({
      machine, container: { image: "i@sha256:x" },
      netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
    });
    expect(cmds.findIndex((c) => c.includes("docker rm -f")))
      .toBeLessThan(cmds.findIndex((c) => c.includes("docker run -d")));
  });

  it("stopContainerMiner force-removes by deterministic name and tolerates absence", async () => {
    const { machine, cmds } = machineOf({ "docker rm -f": { code: 1, stderr: "No such container" } });
    await expect(stopContainerMiner(machine, 56, "gauss")).resolves.toBeUndefined();
    expect(cmds[0]).toContain("docker rm -f 'fez-56-gauss'");
  });

  it("transportError from the machine surfaces as a throw, not a fake exit code", async () => {
    const machine: MinerMachine = {
      kind: "ssh", ports: [],
      exec: async () => ({ code: 255, stdout: "", stderr: "unreachable", transportError: true }),
      copy: async () => {},
    };
    await expect(
      runContainerMiner({ machine, container: { image: "i@sha256:x" }, netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {} })
    ).rejects.toThrow(/unreachable/);
  });

  it("compose descriptor drives compose verbs, project-named like the container", async () => {
    const { machine, cmds } = machineOf({
      "compose": { code: 0, stdout: "0\n" },
    });
    await runContainerMiner({
      machine, container: { image: "i@sha256:x", compose: "services: {}" },
      netuid: 2, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
    });
    const joined = cmds.join(" || ");
    expect(joined).toContain("docker compose -p 'fez-2-p'");
    expect(joined).toContain("up -d");
    expect(joined).not.toContain("docker run -d");
  });
});
