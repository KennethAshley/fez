import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { MinerSubmission, SubmissionContext, SubmissionStatus, SubnetMiner } from "@fezchat/extension-api";
import { checkSource, IMAGE, source, type Run } from "./miner-check.js";
import { evaluateRidges, ridgesDevelopmentInstructions } from "./evaluation.js";

const API = "https://agent-upload.ridges.ai";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const ss58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{48}$/);
const date = z.string().max(40).refine(s => Number.isFinite(Date.parse(s)));
const state = z.object({
  set_id: z.number().int(), status: z.string().max(64), approved: z.boolean().nullable(),
  disqualified: z.boolean().nullable(), final_score: z.number().finite().nullable(), rank: z.number().nullable(),
  approved_at: date.nullable(),
});
const agent = z.object({
  agent_id: z.string().uuid(), miner_hotkey: ss58, name: z.string().max(512),
  version_num: z.number().int().nonnegative(), status: z.string().max(64), created_at: date,
  competition_state: state.nullable(),
});
type Agent = z.infer<typeof agent>;
const competition = z.object({ set_id: z.number().int(), name: z.string().nullable(), accepting: z.boolean() });

async function save(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}

function config(ctx: SubmissionContext) {
  const hotkey = ss58.parse(ctx.config.hotkey);
  if (ctx.hotkey && ctx.hotkey !== hotkey) throw Error("Configured Ridges hotkey differs from the adopted miner");
  const setId = z.number().int().positive().parse(ctx.config.competition);
  return { hotkey, setId };
}

function snapshot(hotkey: string, setId: number, agents: Agent[], now: number): SubmissionStatus {
  if (agents.some(a => a.miner_hotkey !== hotkey || a.competition_state?.set_id !== setId)) throw Error("Ridges returned a different hotkey or competition");
  agents.sort((a, b) => b.version_num - a.version_num);
  const latest = agents[0];
  const active = agents.find(a => a.competition_state?.approved && !a.competition_state.disqualified);
  const s = latest?.competition_state;
  const failed = !!s?.disqualified || /^(failed_|rejected$|didnt_qualify$|cancelled$)/.test(s?.status ?? latest?.status ?? "");
  return {
    hotkey, checkedAt: new Date(now).toISOString(),
    phase: !latest ? "not-submitted" : failed ? "failed" : s?.approved ? "active" : "pending",
    activeVersionId: active?.agent_id,
    versions: agents.map(a => ({ id: a.agent_id, name: a.name, version: a.version_num, createdAt: a.created_at,
      activatedAt: a.competition_state?.approved && !a.competition_state.disqualified ? a.competition_state.approved_at : null })),
    detail: latest
      ? `Competition ${setId}: ${s?.status ?? latest.status}. Score: ${s?.final_score ?? "not reported"}; rank: ${s?.rank ?? "not reported"}. Approval is not proof of earnings.`
      : `No submission for this hotkey in competition ${setId}. Register SN62 and prepare funding using the official Ridges tools.`,
  };
}

export function createRidgesSubmission(deps: { fetch?: typeof fetch; run?: Run; now?: () => number } = {}): MinerSubmission {
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  async function request(route: string, body?: FormData): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(API + route, { method: body ? "POST" : "GET", body,
        redirect: "error", signal: AbortSignal.timeout(body ? 60000 : 15000) });
    } catch { throw Error(body ? "Ridges upload outcome unknown; inspect status before retrying" : "Ridges status request failed"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Error(`Ridges HTTP ${response.status}${body ? "; upload stopped, inspect status before retrying" : ""}`);
    }
    try {
      if (!response.body) throw Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) throw Error();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw Error("Ridges response invalid or oversized; check status if uploading"); }
  }
  async function status(ctx: SubmissionContext) {
    const { hotkey, setId } = config(ctx);
    const rows = z.array(agent).max(10000).parse(await request(`/retrieval/all-agents-by-hotkey?miner_hotkey=${encodeURIComponent(hotkey)}&set_id=${setId}`));
    const current = snapshot(hotkey, setId, rows, now());
    try {
      const accepted = JSON.parse(await readFile(join(ctx.workDir, "ridges-upload.json"), "utf8"));
      if (accepted.hotkey === hotkey && accepted.setId === setId && !accepted.agentId) {
        current.phase = "pending";
        current.detail = `Upload outcome unknown; inspect the Ridges dashboard before retrying. Public retrieval cannot prove that this ticket was not redeemed. ${current.detail}`;
      }
      if (accepted.hotkey === hotkey && accepted.setId === setId && typeof accepted.agentId === "string" && !rows.some(a => a.agent_id === accepted.agentId)) {
        current.phase = "pending";
        current.detail = `Accepted agent ${accepted.agentId}; server metadata and screening await refresh. ${current.detail}`;
      }
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw Error("Cannot read local Ridges acceptance receipt");
    }
    return current;
  }
  return {
    notice: "Ridges consumes a single-use funded ticket and stores your OpenRouter runtime and management keys. Screening bills your OpenRouter account. Source checks do not measure coding performance. Mainnet enrollment and funding use the official Ridges tools.",
    status,
    async test(ctx, file) {
      const { hotkey, setId } = config(ctx);
      const bytes = await source(file);
      // The upload endpoint requires UTF-8, even though Python supports other encodings.
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      await checkSource(bytes, deps.run);
      const sha256 = hash(bytes);
      await mkdir(ctx.workDir, { recursive: true });
      await save(join(ctx.workDir, "ridges-test.json"), { sha256, hotkey, setId, persona: ctx.persona, image: IMAGE });
      return { sha256, detail: "Python syntax and synchronous agent_main(input) declaration checked in isolated Docker. Candidate code was not executed; patch validity, dependencies and benchmark performance are untested. Use official Ridges local evaluation before paying to submit." };
    },
    async submit(ctx, file, sha256) {
      const { hotkey, setId } = config(ctx);
      const bytes = await source(file);
      if (!/^[a-f0-9]{64}$/.test(sha256) || hash(bytes) !== sha256) throw Error("Source changed; test the exact bytes again");
      let receipt;
      try { receipt = JSON.parse(await readFile(join(ctx.workDir, "ridges-test.json"), "utf8")); }
      catch { throw Error("Run a successful source check before uploading"); }
      if (receipt.sha256 !== sha256 || receipt.hotkey !== hotkey || receipt.setId !== setId || receipt.persona !== ctx.persona || receipt.image !== IMAGE) throw Error("Source-check receipt does not match this submission");
      const secret = (key: string) => {
        const value = ctx.config[key];
        if (typeof value !== "string" || !value.trim() || value.length > 16384) throw Error(`Configure the ${key} secret before submitting`);
        return value;
      };
      const ticket = secret("ticket").trim();
      let decoded;
      try { decoded = JSON.parse(Buffer.from(ticket, "base64").toString("utf8")); }
      catch { throw Error("Invalid Ridges upload ticket"); }
      if (decoded?.v !== 2 || decoded.hotkey !== hotkey || !["credit", "burn"].includes(decoded.funding)) throw Error("Ticket version, funding or hotkey does not match");
      // The upload endpoint verifies the signature and funding. Avoid ticket/check,
      // whose current upstream middleware logs unredacted JSON ticket bodies.
      const runtime = secret("openrouter_api_key");
      const management = secret("openrouter_management_key");
      const name = ctx.config.name ?? `Fez ${ctx.persona}`;
      if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\x00-\x1f]/.test(name)) throw Error("Invalid Ridges agent name");
      const attemptFile = join(ctx.workDir, "ridges-upload.json");
      let previous;
      try { previous = JSON.parse(await readFile(attemptFile, "utf8")); }
      catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw Error("Cannot read prior Ridges upload receipt"); }
      if (previous && (!previous.agentId || previous.ticketHash === hash(ticket))) throw Error("Prior ticket was attempted; inspect Ridges status and upload receipt before retrying");
      const selected = competition.parse(await request(`/competitions/${setId}`));
      if (selected.set_id !== setId || !selected.accepting) throw Error("Selected competition is not accepting uploads");
      const form = new FormData();
      form.append("agent_file", new Blob([new Uint8Array(bytes)], { type: "text/x-python" }), "agent.py");
      for (const [key, value] of Object.entries({ ticket, name, openrouter_api_key: runtime, openrouter_management_key: management, set_id: String(setId) })) form.append(key, value);
      const attempt = { sha256, hotkey, setId, ticketHash: hash(ticket), attemptedAt: new Date(now()).toISOString() };
      await save(attemptFile, attempt);
      const raw = await request("/upload/agent/ticket", form);
      const accepted = z.object({ status: z.literal("success"), agent_id: z.string().uuid(), miner_hotkey: ss58 }).safeParse(raw);
      if (!accepted.success || accepted.data.miner_hotkey !== hotkey) throw Error("Upload acceptance unknown; inspect Ridges status before retrying");
      const agentId = accepted.data.agent_id;
      try { await save(attemptFile, { ...attempt, agentId }); }
      catch { throw Error(`Ridges accepted agent ${agentId}, but its local receipt could not be saved. Do not upload again.`); }
      try {
        const current = await status(ctx);
        if (current.versions.some(v => v.id === agentId)) return current;
      } catch { /* Preserve the confirmed acceptance when status is unavailable. */ }
      return { hotkey, phase: "pending", checkedAt: new Date(now()).toISOString(),
        versions: [],
        detail: `Accepted agent ${agentId} for competition ${setId}; screening and server version metadata await refresh.` };
    },
  };
}

const ridges: SubnetMiner = {
  netuid: 62, network: "finney", name: "Ridges",
  config: [
    { key: "hotkey", label: "Existing registered SN62 hotkey", type: "string", required: true, pattern: "[1-9A-HJ-NP-Za-km-z]{48}" },
    { key: "competition", label: "Competition ID (Ridges dashboard)", type: "number", required: true },
    { key: "name", label: "Agent display name", type: "string" },
    { key: "evaluation_checkout", label: "Local official Ridges evaluator checkout", type: "string" },
    { key: "evaluation_commit", label: "User-selected evaluator commit (full SHA)", type: "string", pattern: "[0-9a-f]{40}" },
    { key: "evaluation_python", label: "Installed evaluator Python (absolute executable path)", type: "string" },
    { key: "evaluation_task", label: "Local dataset: one materialized Harbor task directory", type: "string" },
    { key: "ticket", label: "Single-use funded upload ticket", type: "secret" },
    { key: "openrouter_api_key", label: "OpenRouter runtime key (shared with Ridges on Submit)", type: "secret" },
    { key: "openrouter_management_key", label: "OpenRouter management key (shared with Ridges on Submit)", type: "secret" },
  ],
  submission: createRidgesSubmission(),
  development: { instructions: ridgesDevelopmentInstructions, evaluate: evaluateRidges },
};
export default [ridges];
