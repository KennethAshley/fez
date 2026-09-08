import { describe, expect, it } from "vitest";
import { sshMachine } from "../src/machine-ssh.js";

/**
 * LIVE smoke — real ssh/scp against a real throwaway droplet. Runs only
 * when FEZ_SMOKE_SSH_HOST is set (CI and normal `vitest --run` skip it);
 * the droplet is created and destroyed by the session driving the smoke.
 */
const HOST = process.env.FEZ_SMOKE_SSH_HOST;

describe.skipIf(!HOST)("SshMachine live smoke", () => {
  const m = () => sshMachine({ host: HOST!, user: "root", ports: [] });

  it("exec runs a real remote command", async () => {
    const r = await m().exec("uname -a", { timeoutMs: 30_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Linux/);
    expect(r.transportError).toBeUndefined();
  }, 60_000);

  it("cwd and env discipline hold on a real shell", async () => {
    const r = await m().exec("pwd && echo \"$FOO\"", { cwd: "/tmp", env: { FOO: "it's alive" }, timeoutMs: 30_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("/tmp\nit's alive\n");
  }, 60_000);

  it("a background child survives the exec returning (the lium hang class)", async () => {
    const r = await m().exec("nohup sleep 30 >/dev/null 2>&1 & echo started", { timeoutMs: 15_000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("started");
  }, 60_000);

  it("copy lands a real file with real content", async () => {
    const machine = m();
    const tmp = `/tmp/fez-smoke-${Date.now()}`;
    const { writeFileSync, rmSync } = await import("node:fs");
    const local = `${process.env.TMPDIR ?? "/tmp"}/fez-smoke-local.txt`;
    writeFileSync(local, "smoke payload\n");
    try {
      await machine.copy(local, tmp);
      const r = await machine.exec(`cat ${tmp}`, { timeoutMs: 30_000 });
      expect(r.stdout).toBe("smoke payload\n");
    } finally {
      rmSync(local, { force: true });
    }
  }, 120_000);

  it("an unreachable port is a transportError, not a dead miner", async () => {
    const bad = sshMachine({ host: HOST!, user: "root", port: 9, ports: [] });
    const r = await bad.exec("true", { timeoutMs: 20_000 });
    expect(r.transportError).toBe(true);
  }, 60_000);

  it("a non-zero remote exit is the command's own status", async () => {
    const r = await m().exec("exit 42", { timeoutMs: 30_000 });
    expect(r).toMatchObject({ code: 42 });
    expect(r.transportError).toBeUndefined();
  }, 60_000);
});
