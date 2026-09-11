import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { expect, it } from "vitest";
import { runRehearsal } from "../../../dev/experiments/coordination/rehearsal.js";
import { KIND_AGENT_TASK, KIND_AGENT_RESULT, KIND_AGENT_METADATA } from "../../../src/protocol/kinds.js";

const packDirectory = fileURLToPath(new URL("../../../dev/experiments/coordination/", import.meta.url));

it.each(["direct", "delegated", "missing-delivery"] as const)("records real Fez transport for the %s scripted rehearsal", async mode => {
  const dir = mkdtempSync(join(tmpdir(), "fez-rehearsal-test-"));
  const output = join(dir, "attempt");
  try {
    const episode = await runRehearsal(output, mode, packDirectory);
    expect(JSON.parse(readFileSync(join(output, "episode.json"), "utf8"))).toEqual(episode);
    expect(episode).toMatchObject({ mode, taskId: "C01", workerKind: "scripted-reference", modelCalls: 0,
      candidateSha256: null, assessment: null });
    expect(episode.events.every(row => verifyEvent(row.event))).toBe(true);
    expect(new Set(episode.events.map(row => row.event.id)).size).toBe(episode.events.length);
    expect(episode.events.map(row => row.receivedMs)).toEqual(episode.events.map(row => row.receivedMs).sort((a,b) => a-b));
    const tasks = episode.events.filter(row => row.event.kind === KIND_AGENT_TASK).map(row => row.event);
    for (const task of tasks) {
      const recipient = task.tags.find(tag => tag[0] === "p")![1];
      const metadata = episode.events.find(row => row.event.kind === KIND_AGENT_METADATA && row.event.pubkey === recipient)!;
      expect(JSON.parse(metadata.event.content).supported_tasks).toContain(task.tags.find(tag => tag[0] === "task_type")![1]);
    }
    const root = tasks.find(event => event.pubkey === episode.roster.buyer)!;
    expect(root.id).toBe(episode.rootTaskId);
    expect(tasks).toHaveLength(mode === "direct" ? 1 : 2);
    if (mode !== "direct") {
      const child = tasks.find(event => event.pubkey === episode.roster.lead)!;
      expect(child.tags).toContainEqual(["e", root.id]);
      expect(child.tags).toContainEqual(["p", episode.roster.specialist]);
      expect(episode.events.some(row => row.event.kind === KIND_AGENT_RESULT &&
        row.event.pubkey === episode.roster.specialist && row.event.tags.some(t => t[0] === "e" && t[1] === child.id))).toBe(true);
    }
    if (mode === "missing-delivery") {
      expect(episode.delivery).toMatchObject({ delivered: false, resultEventId: null, artifacts: {}, checks: null });
      expect(episode.elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(readdirSync(output)).not.toContain("delivered");
    } else {
      expect(episode.delivery.delivered).toBe(true);
      expect(episode.delivery.checks?.exitCode).toBe(0);
      const artifact = readFileSync(join(output, "delivered", "task.mjs"));
      expect(createHash("sha256").update(artifact).digest("hex")).toBe(episode.delivery.artifacts["task.mjs"]);
      const pack = JSON.parse(readFileSync(join(packDirectory, "development-pack.json"), "utf8"));
      expect(artifact.toString()).toBe(pack.fixtures.invoice.reference);
    }
    writeFileSync(join(output, "keep.txt"), "existing work");
    await expect(runRehearsal(output, mode, packDirectory)).rejects.toThrow(/exist/i);
    expect(readFileSync(join(output, "keep.txt"), "utf8")).toBe("existing work");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
