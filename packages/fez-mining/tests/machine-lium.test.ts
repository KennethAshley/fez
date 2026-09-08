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

// record() from @fezchat/lium/cli writes unconditionally to the REAL
// ~/.fez/lium-pods.json — every provisionPod/teardownPod call below passes
// this stub instead so the test suite never touches the live ledger file.
const noRecord = async () => {};

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

  // Pinned live 2026-09-08 (probe pod, timed): `-e KEY=VALUE` makes lium
  // exec wait on the whole remote process tree — a detached background
  // child hangs the call past 180s. The identical command with env inlined
  // as `export K=V; ...` returns in ~2s and the child survives.
  it("exec prefixes cwd as a guarded cd-statement (no cwd flag on the real CLI) and inlines env as export statements", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ results: [{ pod: "p1", exit_code: 0, stdout: "", stderr: "" }] }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.exec("ls", { cwd: "/root/work", env: { FOO: "bar" } });
    expect(calls[0]).toEqual(["exec", "p1", "cd /root/work || exit 97; export FOO='bar'; ls", "--json"]);
  });

  it("exec single-quote-escapes an env value containing a literal quote", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.exec("ls", { env: { FOO: "it's" } });
    expect(calls[0]).toEqual(["exec", "p1", "export FOO='it'\\''s'; ls", "--json"]);
  });

  // Pinned live 2026-09-08: cd/exports must be their OWN statements (`;`),
  // never `&&`-chained into the user command — a trailing `&` in the user
  // command (backgrounding a detached child, e.g. `./miner & echo $! >
  // pid`) would otherwise background the WHOLE `cd && ... && cmd` compound;
  // that subshell's own stdio (inherited from the session) stays open as
  // long as the miner runs, hanging `lium exec` on it for 60s.
  it("exec never && -chains cwd/env into a user command that backgrounds a detached child", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.exec("./miner & echo $! > miner.pid", { cwd: "/root/work", env: { FOO: "bar" } });
    const [, , sent] = calls[0];
    expect(sent).toBe("cd /root/work || exit 97; export FOO='bar'; ./miner & echo $! > miner.pid");
    expect(sent).not.toContain("&&");
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
    expect(calls[0]).toEqual(["exec", "p1", "export FOO='bar'; ls", "--json"]);
  });

  it("copy runs lium scp <pod> <local> <remote>", async () => {
    const { exec, calls } = script({ scp: "" });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    await m.copy("./a.txt", "/root/a.txt");
    expect(calls[0]).toEqual(["scp", "p1", "./a.txt", "/root/a.txt"]);
  });

  // A young pod's sshd can refuse an scp for a while after `up` returns —
  // copy() retries a bounded 3 attempts (10s apart, collapsed here) before
  // giving up, so callers that don't wrap their own retry (unlike
  // deployHotkey) still get one for free.
  it("copy retries a failed scp and resolves once a later attempt succeeds", async () => {
    const prevCopyDelay = process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
    process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = "1";
    try {
      let call = 0;
      const calls: string[][] = [];
      const exec = async (args: string[]) => {
        calls.push(args);
        call++;
        return call < 2 ? { ok: false as const, err: "Failed to upload" } : { ok: true as const, out: "" };
      };
      const m = liumMachine({ podId: "p1", ports: [] }, exec);
      await expect(m.copy("./a.txt", "/root/a.txt")).resolves.toBeUndefined();
      expect(calls.length).toBe(2);
    } finally {
      if (prevCopyDelay === undefined) delete process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = prevCopyDelay;
    }
  });

  it("copy throws once all 3 attempts are exhausted", async () => {
    const prevCopyDelay = process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
    process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = "1";
    try {
      const { exec, calls } = script({}); // no script for scp — always fails
      const m = liumMachine({ podId: "p1", ports: [] }, exec);
      await expect(m.copy("./a.txt", "/root/a.txt")).rejects.toThrow(/no script for scp/);
      expect(calls.length).toBe(3);
    } finally {
      if (prevCopyDelay === undefined) delete process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = prevCopyDelay;
    }
  });

  // Pinned live (Task 12): `lium up` with no NODE_ID and no filters
  // refuses outright ("Must provide either NODE_ID or filters"), so
  // provisionPod picks the node itself — `ls --format json`, cheapest row
  // at/under the ceiling, then `up <node>` positionally.
  it("provisionPod picks the cheapest ls node under the ceiling, then up <uuid> (not huid), then describe", async () => {
    const { exec, calls } = script({
      ls: JSON.stringify([
        { huid: "eager-wolf-aa", id: "b8b06429-0000-0000-0000-000000000001", price_per_hour: "0.42" },
        { huid: "pricier-node-zz", id: "b8b06429-0000-0000-0000-000000000002", price_per_hour: "9.99" },
      ]),
      up: JSON.stringify({ pod: "p9", price_per_hour: "0.42" }),
      describe: JSON.stringify({ host_ip: "1.2.3.4", ports: [{ external: 20001, internal: 22 }, { external: 20002, internal: 8091 }] }),
    });
    const h = await provisionPod({ ports: 2, ttl: "12h", maxUsdHour: 5 }, exec, noRecord);
    expect(h.podId).toBe("p9");
    expect(h.sshHost).toBe("1.2.3.4");
    expect(h.hourlyRate).toBe("0.42");
    expect(h.ports).toContainEqual({ externalIp: "1.2.3.4", externalPort: 20002, internalPort: 8091 });
    expect(calls[0]).toEqual(["ls", "--format", "json"]);
    // Pinned live 2026-09-08: `up <huid>` fails ("Node ... not found"),
    // `up <uuid>` (the row's `id`) deploys — nodeIdOf prefers id over huid.
    expect(calls[1]).toEqual([
      "up", "b8b06429-0000-0000-0000-000000000001", "--yes", "--no-ssh", "--ttl", "12h", "--ports", "2",
    ]);
    expect(calls[2][0]).toBe("describe");
    expect(calls[2]).toContain("--json");
  });

  it("provisionPod refuses when no ls node is at/under the ceiling — never calls up", async () => {
    const { exec, calls } = script({
      ls: JSON.stringify([{ huid: "pricier-node-zz", price_per_hour: "9.99" }]),
    });
    await expect(provisionPod({ maxUsdHour: 1 }, exec, noRecord)).rejects.toThrow(/no node at or under/);
    expect(calls.some((c) => c[0] === "up")).toBe(false);
  });

  // Pinned live 2026-09-08: `up`'s plain-text output has no reliably
  // parseable price, and re-checking one there previously misfired — a
  // GOOD rent (price already validated from the ls row, under the
  // ceiling) got torn down immediately as "couldn't read the price, not
  // renting blind." The ls-selected price is authoritative now; nothing
  // in up's output — however it reads — can override or refuse it.
  it("provisionPod's hourlyRate is the ls-selected price, ignoring anything in up's own output", async () => {
    const { exec, calls } = script({
      ls: JSON.stringify([{ huid: "cheap-node-aa", price_per_hour: "0.5" }]),
      up: "Pod cheap-node-aa is ready. Setup fee waived (was $9.99/hr)",
    });
    const h = await provisionPod({ maxUsdHour: 1 }, exec, noRecord);
    expect(h.podId).toBe("cheap-node-aa");
    expect(h.hourlyRate).toBe("0.5"); // from ls — NOT the $9.99 mentioned in up's text
    expect(calls.some((c) => c[0] === "rm")).toBe(false); // no post-up refusal/teardown anymore
  });

  // Unverified against live CLI — `up` has no --json flag, so a real
  // deployment's success output is plain text, not JSON. This is the
  // documented fallback path.
  it("provisionPod falls back to scraping a HUID pod name out of plain-text up output", async () => {
    const { exec } = script({
      ls: JSON.stringify([{ huid: "eager-wolf-aa", price_per_hour: "0.75" }]),
      up: "Creating pod...\nPod eager-wolf-aa is ready ($0.75/hr)\nSSH: ssh root@eager-wolf-aa.lium.io",
      describe: JSON.stringify({ host_ip: "5.6.7.8", ports: [] }),
    });
    const h = await provisionPod({}, exec, noRecord);
    expect(h.podId).toBe("eager-wolf-aa");
  });

  // Pinned live (Task 12): `ps --format json` (not `ps --json`) → `[]` when
  // no pods are running. Row-key tolerance (pod/id/name/huid) itself is
  // still unverified against a row with an actual pod in it.
  it("podAlive is false when ps lacks the pod", async () => {
    const { exec, calls } = script({ ps: JSON.stringify([{ pod: "other" }]) });
    expect(await podAlive("p9", exec)).toBe(false);
    expect(calls[0]).toEqual(["ps", "--format", "json"]);
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
    await teardownPod("p9", exec, noRecord);
    expect(calls[0][0]).toBe("rm");
    expect(calls[0]).toEqual(["rm", "p9", "--yes"]);
  });
});
