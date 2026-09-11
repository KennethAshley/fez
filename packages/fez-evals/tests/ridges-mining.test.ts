import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import ridges, { createRidgesSubmission } from "../../fez-ridges/src/miner.js";
import { checkSource } from "../../fez-ridges/src/miner-check.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const hotkey = "5".repeat(48);
const agentId = "12345678-1234-4234-8234-123456789abc";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fez-ridges-test-")); dirs.push(dir);
  const file = join(dir, "agent.py");
  await writeFile(file, 'def agent_main(input):\n    return "patch"\n');
  const ctx = { persona: "coder", workDir: dir, walletBin: "/unused-wallet", config: {
    hotkey, competition: 28, ticket: Buffer.from(JSON.stringify({ v: 2, hotkey, funding: "credit" })).toString("base64"),
    openrouter_api_key: "runtime-secret", openrouter_management_key: "management-secret",
  } };
  let accepting = true, uploadFailure = false, readbackFailure = false;
  let rows: unknown[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("https://agent-upload.ridges.ai/")).toBe(true);
    expect(init?.redirect).toBe("error");
    if (url.endsWith("/competitions/28")) return Response.json({ set_id: 28, name: "Database", accepting });
    if (url.includes("/retrieval/")) {
      if (readbackFailure) throw Error("unavailable");
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
      return Response.json(rows);
    }
    if (url.endsWith("/upload/agent/ticket")) {
      if (uploadFailure) throw Error("private credential error must not surface");
      const body = init?.body as FormData;
      expect(await (body.get("agent_file") as Blob).text()).toBe(await readFile(file, "utf8"));
      expect(body.get("set_id")).toBe("28");
      expect(body.get("ticket")).toBe(ctx.config.ticket);
      expect(body.get("openrouter_api_key")).toBe("runtime-secret");
      return Response.json({ status: "success", agent_id: agentId, miner_hotkey: hotkey });
    }
    throw Error(`Unexpected request ${url}`);
  });
  const run = vi.fn(async (args: string[]) => args[0] === "run" ? "source-contract-ok\n" : "");
  const adapter = createRidgesSubmission({ fetch: fetcher as typeof fetch, run });
  return { ctx, file, adapter, fetcher, run,
    close: () => { accepting = false; }, failUpload: () => { uploadFailure = true; }, failReadback: () => { readbackFailure = true; },
    rows: (value: unknown[]) => { rows = value; } };
}

it("exposes SN62 as a submission miner with an explicit cost/key notice", () => {
  expect(ridges[0]).toMatchObject({ netuid: 62, network: "finney" });
  expect(ridges[0].submission?.notice).toContain("bills your OpenRouter");
  expect(ridges[0].container).toBeUndefined();
  expect(ridges[0].config?.filter(f => f.type === "secret").every(f => !f.required)).toBe(true);
});

it("checks without credentials or network, binds receipt, preserves accepted ID and never logs secrets", async () => {
  const f = await fixture();
  const receipt = await f.adapter.test(f.ctx, f.file);
  expect(receipt.prediction).toBeUndefined();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.run.mock.calls[0][0]).toEqual(expect.arrayContaining(["--network=none", "--read-only", "--pull=never"]));
  f.failReadback();
  const result = await f.adapter.submit(f.ctx, f.file, receipt.sha256);
  expect(result.phase).toBe("pending"); expect(result.detail).toContain(agentId);
  const saved = await readFile(join(f.ctx.workDir, "ridges-upload.json"), "utf8");
  expect(saved).toContain(agentId);
  for (const secret of [f.ctx.config.ticket, "runtime-secret", "management-secret"]) expect(saved).not.toContain(secret);
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/Prior ticket/);
});

it("refuses changed source and mismatched hotkey before any request", async () => {
  const f = await fixture(); const r = await f.adapter.test(f.ctx, f.file);
  await writeFile(f.file, "changed");
  await expect(f.adapter.submit(f.ctx, f.file, r.sha256)).rejects.toThrow(/Source changed/);
  expect(f.fetcher).not.toHaveBeenCalled();
  await expect(f.adapter.status({ ...f.ctx, hotkey: "6".repeat(48) })).rejects.toThrow(/differs/);
});

it("refuses mismatched tickets and closed competitions before upload", async () => {
  const f = await fixture(); const r = await f.adapter.test(f.ctx, f.file);
  const ticket = f.ctx.config.ticket;
  f.ctx.config.ticket = Buffer.from(JSON.stringify({ v: 2, hotkey: "6".repeat(48), funding: "credit" })).toString("base64");
  await expect(f.adapter.submit(f.ctx, f.file, r.sha256)).rejects.toThrow(/Ticket/);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.ctx.config.ticket = ticket; f.close();
  await expect(f.adapter.submit(f.ctx, f.file, r.sha256)).rejects.toThrow(/not accepting/);
  expect(f.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

it("persists an uncertain attempt and prevents even an explicit blind retry", async () => {
  const f = await fixture(); const r = await f.adapter.test(f.ctx, f.file); f.failUpload();
  await expect(f.adapter.submit(f.ctx, f.file, r.sha256)).rejects.toThrow(/outcome unknown/);
  const calls = f.fetcher.mock.calls.length;
  await expect(f.adapter.submit(f.ctx, f.file, r.sha256)).rejects.toThrow(/Prior ticket/);
  expect(f.fetcher.mock.calls.length).toBe(calls);
  expect(await f.adapter.status(f.ctx)).toMatchObject({ phase: "pending", detail: expect.stringContaining("Upload outcome unknown") });
});

it("keeps a confirmed acceptance pending when public retrieval has not caught up", async () => {
  const f = await fixture(); const r = await f.adapter.test(f.ctx, f.file);
  await f.adapter.submit(f.ctx, f.file, r.sha256);
  expect(await f.adapter.status(f.ctx)).toMatchObject({ phase: "pending", detail: expect.stringContaining(agentId) });
});

it("reports failed screening and null scores honestly", async () => {
  const f = await fixture();
  f.rows([{ agent_id: agentId, miner_hotkey: hotkey, name: "Coder", version_num: 1, status: "finished", created_at: "2026-09-10T00:00:00Z",
    competition_state: { set_id: 28, status: "rejected", approved: false, disqualified: false, final_score: null, rank: null, approved_at: null } }]);
  const result = await f.adapter.status(f.ctx);
  expect(result.phase).toBe("failed"); expect(result.detail).toContain("Score: not reported");
  expect(result.activeVersionId).toBeUndefined();
});

it("cleans up the isolated check after failure", async () => {
  const run = vi.fn(async (args: string[]) => { if (args[0] === "run") throw Error("failed"); return ""; });
  await expect(checkSource(Buffer.from("bad"), run)).rejects.toThrow("failed");
  expect(run.mock.calls[1][0].slice(0, 2)).toEqual(["rm", "-f"]);
});

it("the real parser accepts synchronous source without executing it and rejects async or invalid source", async () => {
  // Only fixed test fixtures run through the parser here; production always uses Docker.
  const run = async (args: string[], input?: string | Buffer) => args[0] === "rm" ? "" :
    execFileSync("python3", args.slice(args.indexOf("python") + 1), { input, encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "ignore"] });
  await expect(checkSource(Buffer.from('raise RuntimeError("must not execute")\ndef agent_main(input):\n    return "patch"\n'), run)).resolves.toBeUndefined();
  await expect(checkSource(Buffer.from('async def agent_main(input):\n    return "patch"\n'), run)).rejects.toThrow();
  await expect(checkSource(Buffer.from('def agent_main('), run)).rejects.toThrow();
});
