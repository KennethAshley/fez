import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type TaskPayload } from "../../../src/agent/agent.js";
import { type TaskResult } from "../../../src/protocol/client.js";
import { KIND_AGENT_RESULT } from "../../../src/protocol/kinds.js";
import { type StoredEvent } from "../../../packages/fez-relay/src/relay.js";
import { withLocalTeam } from "./local-team.js";

const execute = promisify(execFile);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const waitLimitMs = 5000;
export type RehearsalMode = "direct" | "delegated" | "missing-delivery";

export interface RehearsalEpisode {
  version: "fez-coordination-transport-rehearsal-v1";
  attemptId: string;
  mode: RehearsalMode;
  taskId: "C01";
  packSha256: string;
  nodeVersion: string;
  workerKind: "scripted-reference";
  candidateSha256: null;
  assessment: null;
  modelCalls: 0;
  costMicrousd: null;
  costBasis: "unknown";
  waitLimitMs: number;
  elapsedMs: number;
  rootTaskId: string | null;
  roster: { buyer: string; lead: string; specialist: string };
  events: { receivedMs: number; event: StoredEvent }[];
  errors: string[];
  delivery: {
    delivered: boolean;
    reason: "delivered" | "timeout" | "error";
    resultEventId: string | null;
    artifacts: Record<string, string>;
    checks: { exitCode: number; stdout: string; stderr: string } | null;
  };
}

/** Trusted C01 scripts exercise transport only. Returned code must match the public reference before execution. */
export async function runRehearsal(directory: string, mode: RehearsalMode, packDirectory: string): Promise<RehearsalEpisode> {
  if (!["direct", "delegated", "missing-delivery"].includes(mode)) throw new Error("unknown rehearsal mode");
  const output = resolve(directory);
  await mkdir(output); // Never overwrite an existing attempt.
  await execute(process.execPath, [join(packDirectory, "prepare.mjs"), "C01", join(output, "input")], { timeout: waitLimitMs });
  const packBytes = await readFile(join(packDirectory, "development-pack.json"));
  const pack = JSON.parse(packBytes.toString("utf8"));
  const reference: unknown = pack.fixtures.invoice.reference;
  if (typeof reference !== "string" || !reference) throw new Error("missing trusted C01 reference");
  const instruction = await readFile(join(output, "input", "task.md"), "utf8");
  const files = Object.fromEntries(await Promise.all(["task.mjs", "acceptance.test.mjs", "sources.md"].map(async name =>
    [name, await readFile(join(output, "input", name), "utf8")])));

  return withLocalTeam(["specialist"], mode === "direct" ? 1 : 2, async team => {
    const attemptId = randomUUID();
    const roster = { buyer: team.roster.buyer, lead: team.roster.lead, specialist: team.roster.specialist };
    const episode: RehearsalEpisode = {
      version: "fez-coordination-transport-rehearsal-v1", attemptId, mode, taskId: "C01",
      packSha256: hash(packBytes), nodeVersion: process.version, workerKind: "scripted-reference",
      candidateSha256: null, assessment: null, modelCalls: 0, costMicrousd: null, costBasis: "unknown",
      waitLimitMs, elapsedMs: 0, rootTaskId: null, roster, events: team.events, errors: [],
      delivery: { delivered: false, reason: "error", resultEventId: null, artifacts: {}, checks: null },
    };
    const pending = new Set<Promise<void>>();
    const handle = (worker: (task: TaskPayload) => Promise<void>) => (task: TaskPayload): Promise<void> => {
      const work = worker(task).catch(error => { episode.errors.push(String(error)); });
      pending.add(work);
      void work.then(() => pending.delete(work));
      return work;
    };
    try {
      const buyer = team.clients.buyer;
      const delegator = team.clients.lead;
      const specialist = team.agents.specialist;
      const lead = team.agents.lead;
      specialist.onTask(handle(async task => {
        await task.progress(50, "Returning the public reference fixture; no model invocation.");
        await task.reply({ status: "success", result: { files: { "task.mjs": reference } } });
      }));
      lead.onTask(handle(async task => {
        if (mode === "direct") {
          await task.reply({ status: "success", result: { files: { "task.mjs": reference } } });
          return;
        }
        const child = await delegator.sendTask({
          to: roster.specialist, taskType: "evaluation", instruction: task.content.instruction,
          params: task.content.params, context: { attemptId, phase: "specialist" },
          parentTaskId: task.event.id, timeoutMs: 2000,
        });
        if (child.status !== "success") throw new Error("scripted specialist failed");
        if (mode === "delegated") await task.reply({ status: "success", result: child.result });
        // missing-delivery deliberately leaves the child's result outside the buyer's output.
      }));
      await team.start();
      const taskStarted = performance.now();
      let result: TaskResult | undefined;
      try {
        result = await buyer.sendTask({ to: roster.lead, taskType: "evaluation", instruction,
          params: { files }, context: { attemptId, phase: "root" }, timeoutMs: waitLimitMs });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Task timed out waiting for result" || mode !== "missing-delivery") throw error;
        episode.delivery.reason = "timeout";
      } finally { episode.elapsedMs = Math.round(performance.now() - taskStarted); }
      await Promise.all(pending);
      if (episode.errors.length) throw new Error("scripted worker failed; inspect episode.errors");
      if (result) {
        episode.delivery.resultEventId = result.event.id;
        const returned = result.result?.files;
        if (result.status !== "success" || !returned || typeof returned !== "object" || Array.isArray(returned) ||
          Object.keys(returned).length !== 1 || !("task.mjs" in returned) || returned["task.mjs"] !== reference) {
          throw new Error("refusing to write or execute anything except the exact trusted reference artifact");
        }
        const delivered = join(output, "delivered");
        await mkdir(delivered);
        await writeFile(join(delivered, "task.mjs"), reference, { flag: "wx" });
        await writeFile(join(delivered, "acceptance.test.mjs"), files["acceptance.test.mjs"], { flag: "wx" });
        episode.delivery.delivered = true;
        episode.delivery.reason = "delivered";
        episode.delivery.artifacts["task.mjs"] = hash(reference);
        try {
          const checks = await execute(process.execPath, ["--test", "acceptance.test.mjs"], { cwd: delivered, timeout: waitLimitMs, maxBuffer: 1024 * 1024 });
          episode.delivery.checks = { exitCode: 0, ...checks };
        } catch (error) {
          const failure = error as { code?: number | string; stdout?: string; stderr?: string };
          episode.delivery.checks = { exitCode: typeof failure.code === "number" ? failure.code : 1,
            stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
          throw error;
        }
      }
      if (mode === "missing-delivery" && !episode.events.some(row => row.event.kind === KIND_AGENT_RESULT && row.event.pubkey === roster.specialist)) {
        throw new Error("missing-delivery rehearsal did not complete the specialist handoff");
      }
    } catch (error) {
      episode.errors.push(String(error));
      throw error;
    } finally {
      episode.rootTaskId = team.rootTaskId;
      await writeFile(join(output, "episode.json"), JSON.stringify(episode, null, 2) + "\n", { flag: "wx" });
    }
    return episode;
  });
}
