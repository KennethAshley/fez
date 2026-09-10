import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { SubmissionContext, SubmissionStatus } from "@fezchat/extension-api";
import { loadDescriptors } from "./descriptors.js";
import { resolveConfig } from "./config.js";
import { preflightMiner } from "./preflight.js";
import { getSecret } from "./secrets.js";
import { fezHome, readState, upsertMiner, updateState } from "./state.js";

export type SubmissionAction = "status" | "register" | "test" | "submit";

/** Both GUI and MCP use these verbs; no process/machine lifecycle is involved. */
export async function submissionCommand(
  action: SubmissionAction, netuid: number, persona: string,
  options: { file?: string; sha256?: string } = {},
  home = fezHome(), walletBin = path.join(home, "bin", "fez-wallet"),
) {
  try { return await performSubmission(action,netuid,persona,options,home,walletBin); }
  catch (error) {
    const message=error instanceof Error ? error.message : "Submission refresh failed";
    if (action === "status" && !message.includes("operation is in progress")) {
      await updateState(home,s => {
        const entry=s.miners.find(m=>m.netuid===netuid && m.persona===persona);
        return entry?.mode === "submission" ? upsertMiner(s,{...entry,submissionError:message}) : undefined;
      });
    }
    throw error;
  }
}

async function performSubmission(
  action: SubmissionAction, netuid: number, persona: string,
  options: {file?:string;sha256?:string}, home: string, walletBin: string,
) {
  if (!Number.isSafeInteger(netuid) || netuid < 0) throw Error("Invalid netuid");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(persona)) throw Error("Invalid persona name");
  if (!["status", "register", "test", "submit"].includes(action)) throw Error("Unknown submission action");
  if ((action === "test" || action === "submit") && !options.file) throw Error("--file is required");
  if (action === "submit" && !/^[a-f0-9]{64}$/.test(options.sha256 ?? "")) throw Error("--sha256 must identify the successfully tested code");
  const d = (await loadDescriptors(home)).find(d => d.netuid === netuid);
  if (!d?.submission) throw Error(`netuid ${netuid} has no submission adapter`);
  const initial = (await readState(home)).miners.find(m => m.netuid === netuid && m.persona === persona);
  if (initial?.machine || initial?.pid) throw Error("Existing process miner must be stopped before adopting a submission");
  const config = resolveConfig(d.config, initial?.config, k => getSecret(netuid, persona, k));
  preflightMiner(d, config, walletBin);
  const ctx: SubmissionContext = {persona, hotkey: initial?.hotkey || undefined, config, walletBin, workDir:path.join(home,"mining",`${netuid}-${persona}`)};
  await fs.mkdir(ctx.workDir, {recursive:true});
  // ponytail: one local lock per miner. A stale lock after a hard crash needs
  // manual removal; never auto-retry an upload whose acceptance is unknown.
  const lockPath = path.join(ctx.workDir,"submission.lock");
  const lock = await fs.open(lockPath,"wx").catch(() => { throw Error("Another submission operation is in progress; retry after it completes"); });
  const save = async (submission: SubmissionStatus) => {
    await updateState(home,s => {
      const old = s.miners.find(m => m.netuid === netuid && m.persona === persona);
      return upsertMiner(s, {...old, netuid, persona, hotkey:submission.hotkey,
        uid:submission.uid ?? old?.uid, desired:"stopped", mode:"submission", pid:undefined,
        submission, submissionError:undefined});
    });
    return submission;
  };
  try {
    if (action === "test") return await d.submission.test(ctx, path.resolve(options.file!));
    if (action === "register") {
      // Explicit enrollment is the only submission verb that can create a key
      // or pay a registration burn. All captured key material stays in Node.
      let hotkey: string;
      try {
        const key = JSON.parse(execFileSync(walletBin,["export-hotkey",persona,"--json"],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:30_000}));
        if (typeof key.ss58Address !== "string") throw Error();
        hotkey = key.ss58Address;
      } catch { throw Error("Could not load enrollment hotkey; wallet output suppressed"); }
      if (ctx.hotkey && ctx.hotkey !== hotkey) throw Error("Enrollment hotkey does not match the recorded miner");
      let registration: { uid: number; hotkey: string };
      try {
        registration = JSON.parse(execFileSync(walletBin,["register",persona,"--netuid",String(netuid),"--hotkey",hotkey,"--json"],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:90_000}));
        if (!Number.isInteger(registration.uid) || registration.hotkey !== hotkey) throw Error();
      } catch { throw Error("Testnet registration failed or timed out; check wallet registration and balance before retrying"); }
      await updateState(home,s => {
        const old = s.miners.find(m => m.netuid === netuid && m.persona === persona);
        return upsertMiner(s,{...old,netuid,persona,hotkey,uid:registration.uid,desired:"stopped",mode:"submission"});
      });
      ctx.hotkey = hotkey;
    }
    return await save(action === "submit"
      ? await d.submission.submit(ctx,path.resolve(options.file!),options.sha256!)
      : await d.submission.status(ctx));
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
