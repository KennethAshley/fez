import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MinerSubmission, SubmissionContext, SubnetMiner } from "@fezchat/extension-api";
import { agents, COOLDOWN, id, identity, record, request, statusOf, uidFor } from "./client.js";
import { candidate, IMAGE, run, sandbox, type Exec } from "./sandbox.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const receiptPath = (ctx: SubmissionContext) => join(ctx.workDir, "numinous-test.json");

// Injection stays at I/O boundaries so tests never touch a real wallet or API.
export function createSubmission(deps: { exec?: Exec; fetch?: typeof fetch; now?: () => number } = {}): MinerSubmission {
  const exec = deps.exec ?? run;
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  return {
    async status(ctx) {
      const deadline = Date.now() + 75000;
      const pair = await identity(ctx, exec, deadline);
      try {
        const all = await agents(pair, fetcher, deadline, now);
        return statusOf(pair.address, all, now(), await uidFor(ctx, pair.address, exec, deadline));
      } finally { pair.lock(); }
    },
    async test(ctx, sourcePath) {
      const bytes = await candidate(sourcePath);
      await mkdir(ctx.workDir, { recursive: true });
      await rm(receiptPath(ctx), { force: true });
      const prediction = await sandbox(bytes, exec);
      const sha256 = digest(bytes);
      const receipt = { format: 1, sha256, persona: ctx.persona, hotkey: ctx.hotkey, image: IMAGE, prediction, testedAt: new Date(now()).toISOString() };
      const temp = `${receiptPath(ctx)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
        await rename(temp, receiptPath(ctx));
      } finally { await rm(temp, { force: true }); }
      return { sha256, prediction, detail: "Passed one synthetic event in an offline, keyless Python 3.11 stdlib sandbox. Inference and validator execution are unverified." };
    },
    async submit(ctx, sourcePath, sha256) {
      const deadline = Date.now() + 75000;
      const bytes = await candidate(sourcePath);
      if (!/^[a-f0-9]{64}$/.test(sha256) || digest(bytes) !== sha256) throw new Error("SHA256 does not match candidate bytes; test changed code again");
      try {
        const receipt = record(JSON.parse(await readFile(receiptPath(ctx), "utf8")));
        if (receipt.format !== 1 || receipt.sha256 !== sha256 || receipt.persona !== ctx.persona || receipt.image !== IMAGE || (receipt.hotkey !== undefined && receipt.hotkey !== ctx.hotkey) || typeof receipt.prediction !== "number" || !Number.isFinite(receipt.prediction) || receipt.prediction < 0 || receipt.prediction > 1) throw new Error();
      } catch { throw new Error("Candidate needs a matching successful local test receipt"); }
      const name = ctx.config.name ?? `Fez ${ctx.persona} SIGNAL`;
      // eslint-disable-next-line no-control-regex -- Reject or strip control characters from untrusted text.
      if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Upload name must be a nonempty string of at most 200 characters");
      const pair = await identity(ctx, exec, deadline);
      try {
        const all = await agents(pair, fetcher, deadline, now);
        const before = statusOf(pair.address, all, now());
        if (before.nextUploadAt && now() < Date.parse(before.nextUploadAt)) throw new Error(`Numinous upload cooldown lasts until ${before.nextUploadAt}`);
        const sentAt = now();
        const result = record(await request(pair, "/api/v3/miner/upload_agent", fetcher, deadline, sentAt, { bytes, sha256, name }));
        let acceptedId: string;
        try { acceptedId = id(result.version_id); }
        catch { throw new Error("Numinous upload response lacks a valid version ID; acceptance unknown, check status before any manual retry"); }
        // Preserve the confirmed ID even if readback fails or has not caught up.
        const accepted = {
          id: acceptedId, name, version: typeof result.version_number === "number" && Number.isSafeInteger(result.version_number) && result.version_number >= 0 ? result.version_number : (before.versions[0]?.version ?? -1) + 1,
          createdAt: new Date(sentAt).toISOString(), activatedAt: null, track: "SIGNAL",
        };
        const fallback = statusOf(pair.address, [...all, accepted], now());
        fallback.nextUploadAt = new Date(sentAt + COOLDOWN).toISOString();
        fallback.detail = "Upload accepted; activation and version metadata await status readback. Upload time is the local acceptance estimate. Validator execution, inference, scoring and rewards are unverified.";
        try {
          const after = await agents(pair, fetcher, deadline, now);
          if (after.some(v => v.id === acceptedId)) return statusOf(pair.address, after, now());
        } catch { /* Acceptance must survive an unavailable status API. */ }
        return fallback;
      } finally { pair.lock(); }
    },
  };
}

const numinous: SubnetMiner = {
  netuid: 155, network: "test", name: "Numinous",
  config: [{ key: "name", label: "Upload display name", type: "string", required: false }],
  submission: createSubmission(),
};
export default [numinous];
