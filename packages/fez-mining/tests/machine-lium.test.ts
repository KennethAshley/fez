import { describe, expect, it } from "vitest";
import { describePod, liumMachine, provisionPod, podAlive, teardownPod } from "../src/machine-lium.js";

// Fake exec scripted by argv[0] (or "argv[0] argv[1]" for a more specific
// match) — mirrors the real LiumExec signature: (args, timeoutMs?) =>
// {ok:true,out}|{ok:false,err}.
const script = (responses: Record<string, string>) => {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const out = responses[key] ?? responses[args[0]];
    return out !== undefined ? { ok: true as const, out } : { ok: false as const, err: `no script for ${args.join(" ")}` };
  };
  return { exec, calls };
};

describe("liumMachine", () => {
  // Pinned: `lium exec --help` — real flag is bare `--json` (not
  // `--format json`), and the CLI always wraps in `results` even for one
  // pod: {results: [{pod, exit_code, stdout, stderr, error}]} (confirmed by
  // fez-lium's own mcp.ts lium_exec handler, already shipped/working).
  it("exec runs through lium exec and parses exit", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ results: [{ pod: "p1", exit_code: 0, stdout: "hi", stderr: "" }] }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    const r = await m.exec("echo hi");
    expect(r).toMatchObject({ code: 0, stdout: "hi" });
    expect(calls[0]).toEqual(["exec", "p1", "echo hi", "--json"]);
  });

  it("exec prefixes cwd with cd (no cwd flag on the real CLI) and forwards env as -e", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ results: [{ pod: "p1", exit_code: 0, stdout: "", stderr: "" }] }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.exec("ls", { cwd: "/root/work", env: { FOO: "bar" } });
    expect(calls[0]).toEqual(["exec", "p1", "-e", "FOO=bar", "cd /root/work && ls", "--json"]);
  });

  // Pinned: `lium scp --help` — TARGETS (pod) then SOURCE then optional
  // DESTINATION, no "pod:path" colon syntax. Matches mcp.ts's lium_copy.
  // C1: regardless of who forwards it, a loader-affecting env name never
  // reaches the pod — same philosophy as the host's gui.ts spawn seam.
  it("exec refuses loader-affecting env names regardless of what the caller passes", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.exec("ls", {
      env: {
        PATH: "/evil", HOME: "/evil", LD_PRELOAD: "x", DYLD_INSERT_LIBRARIES: "y",
        NODE_OPTIONS: "z", FOO: "bar",
      },
    });
    expect(calls[0]).toEqual(["exec", "p1", "-e", "FOO=bar", "ls", "--json"]);
  });

  it("copy runs lium scp <pod> <local> <remote>", async () => {
    const { exec, calls } = script({ scp: "" });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.copy("./a.txt", "/root/a.txt");
    expect(calls[0]).toEqual(["scp", "p1", "./a.txt", "/root/a.txt"]);
  });

  it("provisionPod runs up then describe and returns the port map", async () => {
    const { exec, calls } = script({
      up: JSON.stringify({ pod: "p9", price_per_hour: "0.42" }),
      describe: JSON.stringify({ host_ip: "1.2.3.4", ports: [{ external: 20001, internal: 22 }, { external: 20002, internal: 8091 }] }),
    });
    const h = await provisionPod({ ports: 2, ttl: "12h" }, exec);
    expect(h.podId).toBe("p9");
    expect(h.sshHost).toBe("1.2.3.4");
    expect(h.hourlyRate).toBe("0.42");
    expect(h.ports).toContainEqual({ externalIp: "1.2.3.4", externalPort: 20002, internalPort: 8091 });
    // Pinned: `lium up --help` has no --format/--json flag at all (unlike
    // ls/ps/exec/describe). No NODE_ID positional either — filters
    // (--ports) auto-select the node. --yes/--no-ssh avoid a confirmation
    // prompt and an interactive SSH session hanging the process (mirrors
    // fez-lium's lium_up handler).
    expect(calls[0]).toEqual(["up", "--yes", "--no-ssh", "--ttl", "12h", "--ports", "2"]);
    expect(calls[1][0]).toBe("describe");
    expect(calls[1]).toContain("--json");
  });

  it("provisionPod refuses and tears down when the price exceeds the ceiling", async () => {
    const { exec, calls } = script({
      up: JSON.stringify({ pod: "p9", price_per_hour: "9.99" }),
      rm: "{}",
    });
    await expect(provisionPod({ maxUsdHour: 1 }, exec)).rejects.toThrow(/exceeds/);
    expect(calls.some((c) => c[0] === "rm" && c[1] === "p9")).toBe(true);
  });

  // Unverified against live CLI — `up` has no --json flag, so a real
  // deployment's success output is plain text, not JSON. This is the
  // documented fallback path (Task 12 confirms the real text shape).
  it("provisionPod falls back to scraping a HUID pod name out of plain-text up output", async () => {
    const { exec } = script({
      up: "Creating pod...\nPod eager-wolf-aa is ready ($0.75/hr)\nSSH: ssh root@eager-wolf-aa.lium.io",
      describe: JSON.stringify({ host_ip: "5.6.7.8", ports: [] }),
    });
    const h = await provisionPod({}, exec);
    expect(h.podId).toBe("eager-wolf-aa");
  });

  // Unverified against live CLI (auth-gated) — real `ps --format json` row
  // shape for active pods wasn't observable read-only. Tolerates pod/id/
  // name/huid key names the way cli-lib's matchesNode tolerates them for
  // `ls` rows. Task 12 confirms.
  it("podAlive is false when ps lacks the pod", async () => {
    const { exec } = script({ ps: JSON.stringify([{ pod: "other" }]) });
    expect(await podAlive("p9", exec)).toBe(false);
  });

  it("podAlive is true when ps has the pod under any tolerated key", async () => {
    const { exec } = script({ ps: JSON.stringify([{ huid: "p9" }]) });
    expect(await podAlive("p9", exec)).toBe(true);
  });

  it("describePod returns the real, current port map for an already-running pod", async () => {
    const { exec, calls } = script({
      describe: JSON.stringify({ host_ip: "9.9.9.9", ports: [{ external: 30001, internal: 22 }] }),
    });
    const h = await describePod("p9", exec);
    expect(h).toEqual({ podId: "p9", sshHost: "9.9.9.9", ports: [{ externalIp: "9.9.9.9", externalPort: 30001, internalPort: 22 }] });
    expect(calls[0]).toEqual(["describe", "p9", "--json"]);
  });

  it("describePod throws (doesn't fabricate) when the describe call itself fails", async () => {
    const { exec } = script({});
    await expect(describePod("p9", exec)).rejects.toThrow(/no script for describe/);
  });

  it("teardown calls rm", async () => {
    const { exec, calls } = script({ rm: "{}" });
    await teardownPod("p9", exec);
    expect(calls[0][0]).toBe("rm");
    expect(calls[0]).toEqual(["rm", "p9", "--yes"]);
  });
});
