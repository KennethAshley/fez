import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubmissionContext } from "@fezchat/extension-api";
import miners, { createSubmission } from "../src/miner.js";
import { run, type Exec } from "../src/sandbox.js";

const now = Date.parse("2026-09-10T04:00:00Z");
const endpoint = "wss://test.finney.opentensor.ai:443";
const baseline = "def agent_main(e): return {'event_id': e['event_id'], 'prediction': 0.5}\n";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];
beforeAll(() => cryptoWaitReady());
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

// Public development key only. No real wallet, keychain or network is used.
async function setup() {
  const pair = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const dir = await mkdtemp(join(tmpdir(), "fez-numinous-test-")); dirs.push(dir);
  const ctx: SubmissionContext = { persona: "quill", walletBin: "/test/fez-wallet", workDir: dir, config: {} };
  const file = join(dir, "candidate.py"); await writeFile(file, baseline);
  const calls: { file: string; args: string[]; options: Parameters<Exec>[2] }[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === "docker") {
      if (args[0] === "rm") return { code: 0, stdout: "" };
      const input = JSON.parse(options.input!);
      return { code: 0, stdout: JSON.stringify({ event_id: input.event.event_id, prediction: 0.5, memory: "{}" }) };
    }
    expect(file).toBe(ctx.walletBin);
    if (args[0] === "network") return { code: 0, stdout: `network: test  ⚠️  play money\nendpoint: ${endpoint}\n` };
    if (args[0] === "capabilities") return { code: 0, stdout: JSON.stringify({ existingHotkey: true, metagraphRequireTestnet: true }) };
    if (args[0] === "metagraph") return { code: 0, stdout: '{"uid":76}' };
    expect(args).toEqual(["export-hotkey", ctx.persona, "--existing", "--json"]);
    return { code: 0, stdout: JSON.stringify({ persona: ctx.persona, ss58Address: pair.address, created: false, keyfile: { ss58Address: pair.address, secretPhrase: "//Alice" } }) };
  };
  const requests: { url: string; init: RequestInit }[] = [];
  const responses: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init! });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return Response.json(next ?? { items: [], total_count: 0 });
  };
  return { pair, ctx, file, calls, exec, requests, responses, fetcher,
    adapter: createSubmission({ exec, fetch: fetcher, now: () => now }) };
}

function version(n: number, activated: string | null = null, extra = {}) {
  return { version_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, agent_name: `Version ${n}`, version_number: n, track: "SIGNAL", created_at: "2026-09-10T03:52:00Z", activated_at: activated, ...extra };
}

describe("Numinous status and authentication", () => {
  it("is a testnet155 submission descriptor without a runner", () => {
    expect(miners).toHaveLength(1);
    expect(miners[0]).toMatchObject({ netuid: 155, network: "test", name: "Numinous" });
    expect(miners[0].container).toBeUndefined(); expect(miners[0].start).toBeUndefined();
    expect(miners[0].config).toEqual([expect.objectContaining({ key: "name", type: "string", required: false })]);
  });

  it.each([
    "network: finney\nendpoint: wss://entrypoint-finney.opentensor.ai:443",
    `network: test\nendpoint: ${endpoint}.evil`,
    `network: testing\nendpoint: ${endpoint}`,
    `network: test\nnetwork: finney\nendpoint: ${endpoint}`,
  ])("rejects an unsafe network before exporting a key: %s", async output => {
    const s = await setup();
    const adapter = createSubmission({ exec: async (...args) => { s.calls.push({ file: args[0], args: args[1], options: args[2] }); return { code: 0, stdout: output }; }, fetch: s.fetcher });
    await expect(adapter.status(s.ctx)).rejects.toThrow(/testnet|network/i);
    expect(s.calls.map(c => c.args[0])).toEqual(["network"]); expect(s.requests).toEqual([]);
  });

  it.each(["fez-wallet — per-agent allowance wallets", "{}", '{"existingHotkey":true,"metagraphRequireTestnet":false}'])("refuses an old wallet before key export: %s", async output => {
    const s = await setup();
    const exec: Exec = async (...args) => {
      if (args[1][0] === "network") return s.exec(...args);
      s.calls.push({ file: args[0], args: args[1], options: args[2] });
      return { code: 0, stdout: output };
    };
    await expect(createSubmission({ exec, fetch: s.fetcher }).status(s.ctx)).rejects.toThrow(/Update.*Wallet.*0.1.14/);
    expect(s.calls.map(c => c.args[0])).toEqual(["network", "capabilities"]);
    expect(s.requests).toEqual([]);
  });

  it("rejects an absent key and suppresses secret subprocess errors", async () => {
    const s = await setup();
    const exec: Exec = async (...args) => ["network", "capabilities"].includes(args[1][0]) ? s.exec(...args) : Promise.reject(new Error("SECRET stderr stdout keyfile"));
    await expect(createSubmission({ exec, fetch: s.fetcher }).status(s.ctx)).rejects.toThrow(/^Could not load existing wallet hotkey$/);
    expect(s.requests).toEqual([]);
  });

  it.each([true, false])("refuses created or mismatched hotkeys (%s) before HTTP", async created => {
    const s = await setup();
    const exec: Exec = async (...args) => ["network", "capabilities"].includes(args[1][0]) ? s.exec(...args) : { code: 0, stdout: JSON.stringify({ persona: "quill", created, ss58Address: s.pair.address, keyfile: { secretPhrase: "//Alice" } }) };
    await expect(createSubmission({ exec, fetch: s.fetcher }).status({ ...s.ctx, hotkey: created ? s.pair.address : "wrong" })).rejects.toThrow(/hotkey/i);
    expect(s.requests).toEqual([]);
  });

  it("adopts existing data and separates pending latest from an older active version", async () => {
    const s = await setup();
    const old = version(0, "2026-09-07T00:00:00Z", { created_at: "2026-09-06T03:52:00Z" });
    const pending = version(1);
    s.responses.push({ items: [old, pending], total_count: 2 });
    const status = await s.adapter.status(s.ctx);
    expect(status).toMatchObject({ hotkey: s.pair.address, uid: 76, phase: "pending", activeVersionId: old.version_id, nextUploadAt: "2026-09-13T03:52:00.000Z" });
    expect(status.versions.map(v => v.id)).toEqual([pending.version_id, old.version_id]);
    expect(status.detail).toMatch(/execution.*unverified/i);
    const req = s.requests[0]; const h = new Headers(req.init.headers);
    expect(req.url).toBe("https://stg.numinous.earth/api/v3/miner/agents?limit=100&offset=0");
    expect(req.init.redirect).toBe("error"); expect(req.init.signal).toBeInstanceOf(AbortSignal);
    expect(h.get("X-Payload")).toBe(`${s.pair.address}:1789012800`);
    expect(h.get("Miner-Public-Key")).toBe(Buffer.from(s.pair.publicKey).toString("hex"));
    expect(signatureVerify(h.get("X-Payload")!, Buffer.from(h.get("Authorization")!.slice(7), "base64"), s.pair.publicKey).isValid).toBe(true);
    expect(s.calls.find(c => c.args[0] === "metagraph")!.args).toEqual(["metagraph", "--netuid", "155", "--hotkey", s.pair.address, "--require-testnet", "--json"]);
    expect(JSON.stringify(status)).not.toContain("//Alice");
  });

  it("keeps staging status but omits UID if wallet network changes during the API call", async () => {
    const s = await setup();
    let switched = false;
    const fetcher: typeof fetch = async (...args) => { const response = await s.fetcher(...args); switched = true; return response; };
    const exec: Exec = async (...args) => {
      if (args[1][0] !== "metagraph") return s.exec(...args);
      expect(switched).toBe(true);
      expect(args[1]).toContain("--require-testnet");
      return { code: 1, stdout: "" }; // The wallet guard refuses before connecting.
    };
    s.responses.push({ items: [version(0)], total_count: 1 });
    const status = await createSubmission({exec, fetch: fetcher}).status(s.ctx);
    expect(status.phase).toBe("pending");
    expect(status.versions).toHaveLength(1);
    expect(status.uid).toBeUndefined();
  });

  it.each([
    [[], "not-submitted"],
    [[version(0, "2026-09-10T00:00:00Z")], "active"],
    [[version(0, "2026-09-11T00:00:00Z")], "pending"],
    [[version(0, null, { track: "MAIN" })], "not-submitted"],
  ])("reports only SIGNAL activation from timestamps", async (items, phase) => {
    const s = await setup(); s.responses.push({ items, total_count: items.length });
    expect((await s.adapter.status(s.ctx)).phase).toBe(phase);
  });

  it("adopts the previously recorded testnet version without creating keys or uploading", async () => {
    const s = await setup();
    s.responses.push({ items: [version(0, null, { version_id: "14cfd757-78a3-4f46-9cfa-115ff0142ec8", agent_name: "Fez drift testnet baseline" })], total_count: 1 });
    const result = await s.adapter.status(s.ctx);
    expect(result.versions[0]).toMatchObject({ id: "14cfd757-78a3-4f46-9cfa-115ff0142ec8", version: 0, activatedAt: null });
    expect(result.phase).toBe("pending");
    expect(s.requests.every(r => r.init.method === "GET")).toBe(true);
    expect(s.calls.filter(c => c.args[0] === "export-hotkey").every(c => c.args.includes("--existing"))).toBe(true);
  });

  it("stops pagination within the shared host deadline", async () => {
    const s = await setup(); let clock = now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const fetcher: typeof fetch = async () => {
        const page = Math.floor((clock - now) / 15000); clock += 15000;
        return Response.json({ items: Array.from({ length: 100 }, (_, i) => version(page * 100 + i)) });
      };
      await expect(createSubmission({ exec: s.exec, fetch: fetcher }).status(s.ctx)).rejects.toThrow(/timed out/i);
      expect(clock - now).toBeLessThan(120000);
    } finally { spy.mockRestore(); }
  });

  it("paginates to find an older active version", async () => {
    const s = await setup();
    s.responses.push({ items: Array.from({ length: 100 }, (_, i) => version(i + 1)), total_count: 101 }, { items: [version(0, "2026-09-07T00:00:00Z")], total_count: 101 });
    const status = await s.adapter.status(s.ctx);
    expect(status.activeVersionId).toBe(version(0).version_id);
    expect(s.requests[1].url).toContain("offset=100");
  });

  it.each([
    { items: "wrong" }, { items: [], total_count: -1 },
    { items: [version(0, null, { version_number: "0" })] },
    { items: [version(0, null, { created_at: "yesterday" })] },
    { items: [version(0, "bad date")] },
    { items: [version(0), version(0)], total_count: 2 },
    { items: [], total_count: 1001 },
    { items: [version(0)], total_count: 100 },
  ])("fails closed on malformed or incomplete API data", async payload => {
    const s = await setup(); s.responses.push(payload);
    await expect(s.adapter.status(s.ctx)).rejects.toThrow(/response|pagination/i);
  });

  it("bounds repeated pages even without a reported total", async () => {
    const s = await setup();
    for (let page = 0; page < 11; page++) s.responses.push({ items: Array.from({ length: 100 }, (_, i) => version(page * 100 + i)) });
    await expect(s.adapter.status(s.ctx)).rejects.toThrow(/pagination/i);
    expect(s.requests.length).toBeLessThanOrEqual(10);
  });

  it.each([new Error("SECRET fetch headers"), new Response("SECRET response", { status: 429 }), new Response("SECRET invalid json"), new Response('"' + "a".repeat(1024 * 1024) + '"')])("does not expose transport errors or bodies", async failure => {
    const s = await setup(); s.responses.push(failure);
    let message = ""; try { await s.adapter.status(s.ctx); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/Numinous/); expect(message).not.toContain("SECRET"); expect(message.length).toBeLessThan(180);
  });
});

describe("isolated test and SHA-bound submission", () => {
  it("sends bytes and an event over stdin to a hardened pinned Docker image, without any wallet access", async () => {
    const s = await setup(); const result = await s.adapter.test(s.ctx, s.file);
    expect(result.sha256).toBe(hash(baseline)); expect(result.prediction).toBe(0.5);
    const call = s.calls.find(c => c.args[0] === "run")!;
    expect(call.file).toBe("docker");
    for (const flag of ["--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--pids-limit=32", "--pull=never"])
      expect(call.args).toContain(flag);
    expect(call.args).toContain("python:3.11-slim@sha256:9534e5a8e315485d4061ed659af0fd78a284c015f9b73661b41d6bab25604534");
    expect(call.args.some(a => /^(--volume|-v|--env|-e|--mount)$/.test(a))).toBe(false);
    expect(call.args.join(" ")).not.toContain(baseline);
    expect(Buffer.from(JSON.parse(call.options.input!).source, "base64").toString()).toBe(baseline);
    expect(call.options.timeoutMs).toBeLessThanOrEqual(30000);
    expect(s.calls.every(c => c.file === "docker")).toBe(true); expect(s.requests).toEqual([]);
    expect((await readdir(s.ctx.workDir)).some(p => p.endsWith(".json"))).toBe(true);
  });

  it.each([
    { code: 1, stdout: "SECRET Python traceback" },
    { code: 0, stdout: '{"event_id":"fez-offline-check","prediction":1.1}' },
    { code: 0, stdout: '{"event_id":"wrong","prediction":0.5}' },
    { code: 0, stdout: '{"event_id":"fez-offline-check","prediction":true}' },
    { code: 0, stdout: '{"event_id":"fez-offline-check","prediction":null}' },
    { code: 0, stdout: '{"event_id":"fez-offline-check","prediction":0.5,"memory":{}}' },
    { code: 0, stdout: 'NaN' },
  ])("rejects failed/invalid Docker results without a receipt", async output => {
    const s = await setup(); const exec: Exec = async () => output;
    await expect(createSubmission({ exec }).test(s.ctx, s.file)).rejects.toThrow(/sandbox|prediction/i);
    expect(await readdir(s.ctx.workDir)).toEqual(["candidate.py"]);
  });

  it("cleans up its container after timeout and suppresses subprocess details", async () => {
    const s = await setup(); const calls: string[][] = [];
    const exec: Exec = async (_, args) => { calls.push(args); if (args[0] === "run") throw new Error("SECRET daemon output"); return { code: 0, stdout: "" }; };
    await expect(createSubmission({ exec }).test(s.ctx, s.file)).rejects.toThrow(/^Numinous sandbox failed or timed out$/);
    expect(calls[1].slice(0, 2)).toEqual(["rm", "-f"]);
    expect(calls[1][2]).toBe(calls[0][calls[0].indexOf("--name") + 1]);
  });

  it("rejects oversized code before launching Docker or touching keys", async () => {
    const s = await setup(); await writeFile(s.file, "x".repeat(1024 * 1024 + 1));
    await expect(s.adapter.test(s.ctx, s.file)).rejects.toThrow(/size|MiB/i);
    await expect(s.adapter.submit(s.ctx, s.file, "a".repeat(64))).rejects.toThrow(/size|MiB/i);
    expect(s.calls).toEqual([]);
  });

  it("rejects untested, wrong-digest and changed code before wallet or HTTP", async () => {
    const s = await setup();
    await expect(s.adapter.submit(s.ctx, s.file, hash(baseline))).rejects.toThrow(/test/i);
    await s.adapter.test(s.ctx, s.file); s.calls.length = 0;
    await expect(s.adapter.submit(s.ctx, s.file, "a".repeat(64))).rejects.toThrow(/SHA256|changed/i);
    await writeFile(s.file, baseline + "# changed\n");
    await expect(s.adapter.submit(s.ctx, s.file, hash(baseline))).rejects.toThrow(/SHA256|changed/i);
    expect(s.calls).toEqual([]); expect(s.requests).toEqual([]);
  });

  it("binds receipts to the persona and invalidates a previous success when retesting fails", async () => {
    const s = await setup(); await s.adapter.test(s.ctx, s.file);
    await expect(s.adapter.submit({ ...s.ctx, persona: "scout" }, s.file, hash(baseline))).rejects.toThrow(/test receipt/i);
    await expect(createSubmission({ exec: async () => ({ code: 1, stdout: "" }) }).test(s.ctx, s.file)).rejects.toThrow(/sandbox/i);
    await expect(s.adapter.submit(s.ctx, s.file, hash(baseline))).rejects.toThrow(/test receipt/i);
    expect(s.requests).toEqual([]);
  });

  it("keeps the captured tested bytes when the file changes during preflight", async () => {
    const s = await setup(); await s.adapter.test(s.ctx, s.file);
    const exec: Exec = async (...args) => { if (args[1][0] === "network") await writeFile(s.file, "changed after read"); return s.exec(...args); };
    s.responses.push({ items: [], total_count: 0 }, { version_id: version(0).version_id }, new Error("readback unavailable"));
    await createSubmission({ exec, fetch: s.fetcher, now: () => now }).submit(s.ctx, s.file, hash(baseline));
    const form = s.requests.find(r => r.init.method === "POST")!.init.body as FormData;
    expect(await (form.get("agent_file") as File).text()).toBe(baseline);
  });

  it("blocks a recent upload before POST", async () => {
    const s = await setup(); await s.adapter.test(s.ctx, s.file);
    s.responses.push({ items: [version(0)], total_count: 1 });
    await expect(s.adapter.submit(s.ctx, s.file, hash(baseline))).rejects.toThrow(/cooldown.*2026-09-13/i);
    expect(s.requests.every(r => r.init.method !== "POST")).toBe(true);
  });

  it("uploads exactly tested bytes with SIGNAL and a hash signature; preserves acceptance when readback fails", async () => {
    const s = await setup(); s.ctx.config.name = "My SIGNAL agent";
    await s.adapter.test(s.ctx, s.file);
    const accepted = { version_id: "14cfd757-78a3-4f46-9cfa-115ff0142ec8", version_number: 0, miner_uid: 76 };
    s.responses.push({ items: [], total_count: 0 }, accepted, new Error("readback unavailable"));
    const result = await s.adapter.submit(s.ctx, s.file, hash(baseline));
    expect(result.phase).toBe("pending"); expect(result.versions[0].id).toBe(accepted.version_id);
    expect(result.detail).toMatch(/accepted/i);
    const req = s.requests.find(r => r.init.method === "POST")!;
    expect(req.url).toBe("https://stg.numinous.earth/api/v3/miner/upload_agent");
    const h = new Headers(req.init.headers); expect(h.get("X-Payload")).toBe(`${s.pair.address}:${hash(baseline)}`);
    expect(signatureVerify(h.get("X-Payload")!, Buffer.from(h.get("Authorization")!.slice(7), "base64"), s.pair.publicKey).isValid).toBe(true);
    const form = req.init.body as FormData;
    expect(form.get("track")).toBe("SIGNAL"); expect(form.get("name")).toBe("My SIGNAL agent");
    const upload = form.get("agent_file") as File;
    expect(upload.name).toBe("agent.py"); expect(await upload.text()).toBe(baseline);
    expect(s.requests.filter(r => r.init.method === "POST")).toHaveLength(1);
  });

  it("never retries a failed POST or leaks its response body", async () => {
    const s = await setup(); await s.adapter.test(s.ctx, s.file);
    s.responses.push({ items: [], total_count: 0 }, new Response("SECRET upstream body", { status: 500 }));
    await expect(s.adapter.submit(s.ctx, s.file, hash(baseline))).rejects.toThrow(/Numinous.*500/);
    expect(s.requests.filter(r => r.init.method === "POST")).toHaveLength(1);
  });

  it("the process runner bounds output, timeout and nonzero exit without stderr", async () => {
    const options = { timeoutMs: 1000, maxBytes: 100 };
    expect(await run(process.execPath, ["-e", "process.stderr.write('SECRET'); process.stdout.write('ok'); process.exitCode=4"], options)).toEqual({ code: 4, stdout: "ok" });
    await expect(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], options)).rejects.toThrow(/process/i);
    await expect(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { ...options, timeoutMs: 50 })).rejects.toThrow(/process/i);
  });
});
