import { describe, expect, it } from "vitest";
import { sshMachine, parseSshTarget, type SshSpec } from "../src/machine-ssh.js";

// Fake process runner scripted by argv[0] — mirrors SshRun:
// (argv, timeoutMs?) => {code, stdout, stderr} | throws for spawn failure.
const script = (responses: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    const r = responses[argv[0]];
    if (!r) throw new Error(`no script for ${argv[0]}`);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
};

const SPEC: SshSpec = { host: "165.1.2.3", user: "root", ports: [] };

describe("parseSshTarget", () => {
  it("parses user@host, user@host:port, and bare host", () => {
    expect(parseSshTarget("root@165.1.2.3")).toEqual({ user: "root", host: "165.1.2.3" });
    expect(parseSshTarget("ken@air.local:2222")).toEqual({ user: "ken", host: "air.local", port: 2222 });
    expect(parseSshTarget("165.1.2.3")).toEqual({ user: "root", host: "165.1.2.3" });
  });

  it("refuses shapes that would smuggle ssh options", () => {
    expect(() => parseSshTarget("-oProxyCommand=evil@h")).toThrow();
    expect(() => parseSshTarget("host -oProxyCommand=evil")).toThrow();
    expect(() => parseSshTarget("a@b:notaport")).toThrow();
  });
});

describe("sshMachine", () => {
  it("exec runs ssh with BatchMode and returns the remote exit code", async () => {
    const { run, calls } = script({ ssh: { code: 0, stdout: "hi" } });
    const m = sshMachine(SPEC, run);
    const r = await m.exec("echo hi");
    expect(r).toMatchObject({ code: 0, stdout: "hi" });
    expect(calls[0]).toEqual(["ssh", "-o", "BatchMode=yes", "root@165.1.2.3", "echo hi"]);
  });

  it("exec applies the shared cwd/env discipline (guarded cd, export statements)", async () => {
    const { run, calls } = script({ ssh: { code: 0 } });
    const m = sshMachine(SPEC, run);
    await m.exec("ls", { cwd: "/root/work", env: { FOO: "it's" } });
    expect(calls[0][calls[0].length - 1]).toBe(`cd '/root/work' || exit 97; export FOO='it'\\''s'; ls`);
  });

  it("exec passes port and identity file when the spec has them", async () => {
    const { run, calls } = script({ ssh: { code: 0 } });
    const m = sshMachine({ ...SPEC, port: 2222, keyPath: "/k/id" }, run);
    await m.exec("true");
    expect(calls[0]).toEqual(["ssh", "-o", "BatchMode=yes", "-p", "2222", "-i", "/k/id", "root@165.1.2.3", "true"]);
  });

  it("ssh exit 255 (connection failure) is a transportError, not a dead process", async () => {
    const { run } = script({ ssh: { code: 255, stderr: "Connection refused" } });
    const m = sshMachine(SPEC, run);
    const r = await m.exec("true");
    expect(r.transportError).toBe(true);
    expect(r.code).not.toBe(0);
  });

  it("a non-255 remote exit is the command's real status, no transportError", async () => {
    const { run } = script({ ssh: { code: 97, stderr: "" } });
    const m = sshMachine(SPEC, run);
    const r = await m.exec("false");
    expect(r).toMatchObject({ code: 97 });
    expect(r.transportError).toBeUndefined();
  });

  it("copy runs scp -r with port/key mapped to scp's flags", async () => {
    const { run, calls } = script({ scp: { code: 0 } });
    const m = sshMachine({ ...SPEC, port: 2222, keyPath: "/k/id" }, run);
    await m.copy("/tmp/f", "/root/dest");
    expect(calls[0]).toEqual(["scp", "-o", "BatchMode=yes", "-P", "2222", "-i", "/k/id", "-r", "/tmp/f", "root@165.1.2.3:/root/dest"]);
  });

  it("copy failure throws with stderr", async () => {
    const { run } = script({ scp: { code: 1, stderr: "scp: no space" } });
    const m = sshMachine(SPEC, run);
    await expect(m.copy("/tmp/f", "/dest")).rejects.toThrow(/no space/);
  });

  it("declared ports ride through as the machine's ports", () => {
    const ports = [{ externalIp: "165.1.2.3", externalPort: 8091, internalPort: 8091 }];
    expect(sshMachine({ ...SPEC, ports }, script({}).run).ports).toEqual(ports);
  });
});
