#!/usr/bin/env node
import { developmentCommand, startDevelopmentEvaluation, runDevelopmentEvaluation } from './development.js';
import { ensureMinerThread } from "./thread-store.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MinerEntry, MinerMachineState } from "./state.js";
import { fezHome, readState, writeState, upsertMiner, updateState } from "./state.js";
import { loadDescriptors } from "./descriptors.js";
import { containerLogs, stopContainerMiner } from "./container-runner.js";
import { teardownPod } from "./machine-lium.js";
import { doDestroy } from "./machine-do.js";
import { parseSshTarget } from "./machine-ssh.js";
import { resolveMachine } from "./run.js";
import { resolveConfig } from "./config.js";
import { preflightMiner, walletChain } from "./preflight.js";
import { alive, kill, spawnDetached } from "./procs.js";
import { lium, parseJson, priceOf } from "@fezchat/lium/cli";
import { deleteSecret, getSecret, setSecret } from "./secrets.js";
import type { ConfigField } from "@fezchat/extension-api";
import { submissionCommand, type SubmissionAction } from "./submission.js";

type ConfigVal = string | number | boolean;

// Resolve a sibling bin (fez-wallet, fez-mine-run) by ABSOLUTE path under
// ~/.fez/bin when it exists there, not by bare name — the desktop spawns
// this CLI without ~/.fez/bin on PATH, so a bare "fez-wallet" would ENOENT
// the moment the GUI's Mine flow shells out. Falls back to the bare name
// (dev/test, running straight from dist before an install); env override
// wins for both.
const resolveBin = (envVar: string, name: string): string => {
  const override = process.env[envVar];
  if (override) return override;
  const installed = path.join(os.homedir(), ".fez", "bin", name);
  return existsSync(installed) ? installed : name;
};
const WALLET_BIN = resolveBin("FEZ_WALLET_BIN", "fez-wallet");
const MINE_RUN_BIN = resolveBin("FEZ_MINE_RUN_BIN", "fez-mine-run");

interface RegisterResult {
  persona: string;
  netuid: number;
  uid: number;
  hotkey: string;
  txHash?: string;
  burned?: string;
  adopted?: boolean;
}

/** Pure — the part the test pins. */
export function statusRows(miners: MinerEntry[], isAlive: (pid?: number) => boolean) {
  return miners.map((m) => ({ ...m, alive: m.mode === "submission" ? false : isAlive(m.pid) }));
}

async function cmdSubnets(json: boolean, refresh: boolean): Promise<void> {
  const home = fezHome();
  let s = await readState(home);
  if (refresh) {
    const { allSubnets } = await import("@fezchat/bittensor/subnets");
    const chain = walletChain(WALLET_BIN);
    const subnets = await allSubnets(chain.endpoint, chain.network === "finney");
    const descriptors = await loadDescriptors(home);
    const matching = descriptors.filter(d => !d.network || d.network === chain.network);
    // Local descriptor names identify our testnet deployments even when the
    // chain has not published a name. Never overlay a different network.
    for (const d of matching) {
      const sn = subnets.find(sn => sn.netuid === d.netuid);
      if (sn) sn.name = d.name;
    }
    const covered = matching.filter(d => !d.container?.image.includes("REPLACED_AT_PUBLISH")).map(d => d.netuid);
    const requirementsByNetuid: Record<number, { gpu?: string; publicEndpoint?: boolean }> = {};
    for (const d of matching) {
      if (d.requirements?.gpu || d.requirements?.publicEndpoint) {
        requirementsByNetuid[d.netuid] = {
          ...(d.requirements.gpu ? { gpu: d.requirements.gpu } : {}),
          ...(d.requirements.publicEndpoint ? { publicEndpoint: true } : {}),
        };
      }
    }
    // The chain fetch above takes multiple seconds; re-read + merge rather
    // than writing the whole (possibly stale) state we read before it, so
    // a stop/runner-exit/sentinel write racing the fetch isn't clobbered
    // (worst case: resurrecting a stopped miner).
    await updateState(home,fresh => ({...fresh, subnets, covered, requirementsByNetuid,
      submissionNetuids:matching.filter(d => d.submission).map(d => d.netuid)}));
    s = await readState(home);
  }
  if (json) console.log(JSON.stringify({ subnets: s.subnets, covered: s.covered, submissionNetuids: s.submissionNetuids ?? [], requirementsByNetuid: s.requirementsByNetuid ?? {} }));
  else for (const sn of s.subnets) console.log(`${sn.netuid}\t${sn.name}${s.covered.includes(sn.netuid) ? "\t[covered]" : ""}`);
}

function cmdCost(netuid: number): void {
  // Straight passthrough — fez-wallet already shapes {netuid, rao, tao}.
  process.stdout.write(execFileSync(WALLET_BIN, ["cost", "--netuid", String(netuid), "--json"], { encoding: "utf8" }));
}

// Live on-chain miner performance for the active-miner rows + thread card —
// a best-effort passthrough to `fez-wallet metagraph`. Tolerates every
// failure (no persona, no hotkey yet, chain unreachable) by printing `{}`
// and exiting 0: this is polled every ~30s by the GUI, which must degrade
// to showing nothing rather than surfacing an error banner.
async function cmdMetagraph(netuid: number, persona: string): Promise<void> {
  let out: unknown = {};
  try {
    const entry = await findMiner(fezHome(), netuid, persona);
    const hotkey =
      entry?.hotkey ||
      (JSON.parse(execFileSync(WALLET_BIN, ["status", persona, "--netuid", String(netuid), "--json"], { encoding: "utf8" })) as { address?: string }).address;
    if (hotkey) {
      out = JSON.parse(execFileSync(WALLET_BIN, ["metagraph", "--netuid", String(netuid), "--hotkey", hotkey, "--json"], { encoding: "utf8" }));
    }
  } catch {
    /* best-effort — the GUI renders nothing over a stale/failed read */
  }
  console.log(JSON.stringify(out));
}

async function cmdStart(
  netuid: number,
  persona: string,
  json: boolean,
  machine?: "lium" | "ssh" | "do",
  ssh?: { target?: string; keyPath?: string; servePort?: number }
): Promise<void> {
  const home = fezHome();
  const descriptor = (await loadDescriptors(home)).find(d => d.netuid === netuid);
  if (!descriptor) throw new Error(`no miner descriptor for netuid ${netuid}`);
  if (descriptor.submission) throw new Error(`This miner runs submitted code on validators. Use fez-mine submission status|register|test|submit --netuid ${netuid} --persona ${persona}`);
  const before = (await readState(home)).miners.find(m => m.netuid === netuid && m.persona === persona);
  preflightMiner(descriptor, resolveConfig(descriptor.config, before?.config, k => getSecret(netuid, persona, k)), WALLET_BIN);
  // Validate the ssh target BEFORE the register call below — that call is
  // the burn on a real registration, and a config error must never land
  // after money moved.
  if (machine === "ssh" && !ssh?.target) {
    const s0 = await readState(home);
    const prior = s0.miners.find((m) => m.netuid === netuid && m.persona === persona);
    if (prior?.machine?.kind !== "ssh") {
      console.error("--machine ssh needs --host user@host[:port] (no prior ssh host recorded for this miner)");
      process.exit(1);
    }
  }
  // Idempotent adopt — this call IS the burn on a real registration; the
  // GUI confirms with the human before ever invoking `fez-mine start`.
  // The bare CLI has no such confirmation step, so disclose the live cost
  // here — to stderr, so --json's stdout stays a clean single object.
  // Typing the command is consent; this line is disclosure, not a prompt.
  try {
    const cost = JSON.parse(
      execFileSync(WALLET_BIN, ["cost", "--netuid", String(netuid), "--json"], { encoding: "utf8" })
    ) as { tao: string };
    console.error(`registration may burn ${cost.tao} tTAO from the treasury (free if already registered)`);
  } catch {
    /* cost-fetch failure never blocks start */
  }
  // For a remote miner (lium pod or ssh host), the signing key lives on
  // the machine, not this keychain — export the standalone remote hotkey
  // first and register ITS address, not a locally-derived pair's.
  const registerArgs = ["register", persona, "--netuid", String(netuid), "--json"];
  if (machine === "lium" || machine === "ssh" || machine === "do") {
    const exported = JSON.parse(
      execFileSync(WALLET_BIN, ["export-hotkey", persona, "--json"], { encoding: "utf8" })
    ) as { ss58Address: string };
    registerArgs.push("--hotkey", exported.ss58Address);
  }
  const r = JSON.parse(execFileSync(WALLET_BIN, registerArgs, { encoding: "utf8" })) as RegisterResult;
  let s = await readState(home);
  // upsertMiner fully replaces the entry, so a restart of an already-lium
  // miner must carry its recorded `machine` (podId included) forward
  // itself — otherwise a live pod goes unreferenced and the runner's
  // reattach path never finds it, provisioning (and paying for) a second
  // one. No podId yet on a genuinely first start — the runner provisions
  // the pod on first spawn and records it back onto this entry.
  const existing = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
  // I3: a plain start (no --machine) on a previously-lium entry clears the
  // `machine` field below with no teardown — the pod it names would
  // otherwise go unreferenced and keep billing. Best-effort tear it down
  // first; never block the start over a `lium` hiccup.
  if (machine !== "lium" && existing?.machine?.kind === "lium" && existing.machine.podId) {
    const orphanPodId = existing.machine.podId;
    try {
      await teardownPod(orphanPodId);
      console.error(`tore down orphaned pod ${orphanPodId} from a prior remote run`);
    } catch {
      console.error(`pod ${orphanPodId} may still be running — \`lium rm\` it`);
    }
  }
  s = upsertMiner(s, {
    netuid, persona, hotkey: r.hotkey, uid: r.uid, desired: "running",
    // upsertMiner fully replaces (see the comment above) — a `config set`
    // written onto a stub BEFORE this first start (the New-miner picker's
    // flow) would otherwise vanish right here, the moment `start` gives
    // the stub its real hotkey/uid.
    ...(existing?.config ? { config: existing.config } : {}),
    threadRootId: existing?.threadRootId,
    threadChannelId: existing?.threadChannelId,
    threadRelay: existing?.threadRelay,
    threadRoots: existing?.threadRoots,
    // The preserve is scoped to a lium→lium restart ONLY — carrying
    // `existing.machine` forward unconditionally (any kind, whenever
    // present) meant a later PLAIN `start` (no --machine) on a
    // previously-remote miner reused the stale lium entry and tried the
    // pod path with no key. A local start intentionally writes NO machine
    // field, clearing any stale lium entry back to local. The sentinel/
    // runner reattach path is unaffected — it reads `machine` straight
    // from state, never through cmdStart.
    ...(machine === "lium"
      ? { machine: existing?.machine?.kind === "lium" ? existing.machine : { kind: "lium" as const } }
      : machine === "ssh"
        ? {
            machine: ssh?.target
              ? {
                  kind: "ssh" as const,
                  ...parseSshTarget(ssh.target),
                  ...(ssh.keyPath ? { keyPath: ssh.keyPath } : {}),
                  ...(ssh.servePort ? { servePort: ssh.servePort } : {}),
                }
              : // guarded at the top of cmdStart: no target ⇒ a prior ssh entry exists
                (existing!.machine as Extract<MinerMachineState, { kind: "ssh" }>),
          }
        : machine === "do"
          ? {
              machine:
                existing?.machine?.kind === "do"
                  ? existing.machine
                  : { kind: "do" as const, ...(ssh?.servePort ? { servePort: ssh.servePort } : {}) },
            }
          : {}),
  });
  await writeState(home, s);
  const pid = spawnDetached(MINE_RUN_BIN, [String(netuid), persona]);
  s = await readState(home);
  const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona)!;
  await writeState(home, upsertMiner(s, { ...cur, pid, startedAt: Date.now(), attention: undefined }));
  if (json) console.log(JSON.stringify({ ...r, pid }));
  else console.log(`started ${persona} on netuid ${netuid} (uid ${r.uid}, pid ${pid})`);
}

export async function cmdStop(netuid: number, persona: string, json: boolean): Promise<void> {
  const home = fezHome();
  const s = await readState(home);
  const m = s.miners.find((e) => e.netuid === netuid && e.persona === persona);
  if (m?.mode === "submission" || (await loadDescriptors(home)).find(d => d.netuid === netuid)?.submission) {
    throw Error("This is a validator-hosted submission; stopping a local process cannot deactivate it. Use submission status to inspect its versions.");
  }
  if (m?.pid && alive(m.pid)) kill(m.pid);
  if (m) {
    const podId = m.machine?.kind === "lium" ? m.machine.podId : undefined;
    if (podId) {
      try {
        await teardownPod(podId);
      } catch (e) {
        // Best-effort — a pod that's already gone (or a `lium` hiccup)
        // must not block `stop` from recording the desired state.
        console.error(`fez-mine: teardown of pod ${podId} failed: ${(e as Error).message}`);
      }
    }
    // The teardown call above can take a while — re-read rather than write
    // the snapshot taken before it, so a runner write that landed in the
    // meantime (e.g. it just finished recording a fresh provision) isn't
    // clobbered by this stop.
    const fresh = await readState(home);
    const freshEntry = fresh.miners.find((e) => e.netuid === netuid && e.persona === persona);
    if (freshEntry) {
      const machine =
        freshEntry.machine?.kind === "lium" ? { ...freshEntry.machine, podId: undefined } : freshEntry.machine;
      await writeState(home, upsertMiner(fresh, { ...freshEntry, desired: "stopped", pid: undefined, machine }));
    }
    // A container miner's remote process is reachable by name even when
    // the local runner is long gone — kill it too, best-effort. Lium is
    // excluded on purpose: teardownPod above already destroyed the whole
    // pod, and resolveMachine's lium branch has no "reattach-only" mode —
    // a cleared/missing podId falls through to a FRESH provisionPod, which
    // would rent a brand-new pod just to stop it. ssh (owned) hosts have
    // no such teardown step, so their container can outlive this call.
    if (freshEntry?.machine?.kind === "ssh") {
      const descriptor = (await loadDescriptors(home)).find((x) => x.netuid === netuid);
      if (descriptor?.container) {
        try {
          const { machine } = await resolveMachine(freshEntry, persona, {});
          await stopContainerMiner(machine, netuid, persona);
          console.error(`stopped container fez-${netuid}-${persona}`);
        } catch {
          console.error(`container fez-${netuid}-${persona} may still be running on the machine`);
        }
      }
    }
    // A droplet takes its containers with it on destroy — no separate
    // container-reach step for "do" (unlike "ssh", an owned host that
    // outlives this call). Runs AFTER the container-stop block above, and
    // clears dropletId/host afterward so a later start provisions fresh
    // rather than reattaching to a machine that no longer exists.
    if (freshEntry?.machine?.kind === "do" && freshEntry.machine.dropletId !== undefined) {
      const dropletId = freshEntry.machine.dropletId;
      const token = process.env.DO_API_TOKEN;
      if (token) {
        let destroyed = true;
        try {
          await doDestroy(token, String(dropletId));
        } catch (e) {
          destroyed = false;
          // The DELETE call itself failed (401/5xx/network) — the droplet
          // may well still be alive and billing. State must keep pointing
          // at it (same discipline as the no-token branch below) so it
          // stays findable; clearing dropletId/host here would orphan it.
          console.error(
            `droplet ${dropletId} NOT destroyed (${(e as Error).message}) — delete it in your DO dashboard or it keeps billing`
          );
        }
        if (destroyed) {
          console.error(`destroyed droplet ${dropletId} — billing stopped`);
          // Clear dropletId/host ONLY on this branch — a real destroy just
          // happened, so state forgetting the droplet is correct here. In the
          // no-token branch below, the droplet is still alive and billing;
          // clearing state there would orphan it (nothing left points at it).
          const afterDestroy = await readState(home);
          const afterEntry = afterDestroy.miners.find((e) => e.netuid === netuid && e.persona === persona);
          if (afterEntry) {
            await writeState(
              home,
              upsertMiner(afterDestroy, {
                ...afterEntry,
                machine: { kind: "do" as const, servePort: freshEntry.machine.servePort },
              })
            );
          }
        }
      } else {
        console.error(`droplet ${dropletId} NOT destroyed (no DO_API_TOKEN) — delete it in your DO dashboard or it keeps billing`);
      }
    }
  }
  if (json) console.log(JSON.stringify({ netuid, persona, stopped: true }));
  else console.log(`stopped ${persona} on netuid ${netuid}`);
}

async function cmdStatus(json: boolean): Promise<void> {
  const rows = statusRows((await readState(fezHome())).miners, alive);
  if (json) console.log(JSON.stringify(rows));
  else for (const row of rows) console.log(`${row.netuid}:${row.persona}\t${row.desired}\t${row.alive ? "alive" : "dead"}`);
}

/** Pure — the part the test pins. Row shape per lium-cli ls/display.py compact_executor(). */
export function machineNodeRows(rows: Record<string, unknown>[]): { node: string; usdHour: number | null }[] {
  return rows.map((r) => ({ node: String(r.huid ?? r.id ?? r.index ?? ""), usdHour: priceOf(r) }));
}

// Rentable Lium nodes + prices, for the GUI's machine picker. Tolerates a
// missing/unauthed `lium` CLI — a rented-machine flow one flag away from
// "just use local" must never crash the picker over it.
async function cmdMachines(json: boolean): Promise<void> {
  const r = await lium(["ls", "--format", "json"]);
  if (!r.ok) {
    if (json) console.log(JSON.stringify({ error: r.err }));
    else console.error(r.err);
    return;
  }
  const nodes = machineNodeRows(parseJson<Record<string, unknown>[]>(r.out) ?? []);
  if (json) console.log(JSON.stringify(nodes));
  else for (const n of nodes) console.log(`${n.node}\t${n.usdHour !== null ? `$${n.usdHour}/hr` : "?"}`);
}

// The Lium account balance, for the confirm line next to the burn.
// `lium balance --json` (not `--format json`) is the real flag, pinned
// already in fez-lium's mcp.ts (lium_balance) against the installed CLI.
async function cmdBalance(json: boolean): Promise<void> {
  const r = await lium(["balance", "--json"]);
  if (!r.ok) {
    if (json) console.log(JSON.stringify({ error: r.err }));
    else console.error(r.err);
    return;
  }
  const n = Number(parseJson<{ balance_usd?: unknown }>(r.out)?.balance_usd);
  const balanceUsd = Number.isFinite(n) ? n : null;
  if (json) console.log(JSON.stringify({ balanceUsd }));
  else console.log(balanceUsd !== null ? `$${balanceUsd}` : "unknown");
}

// Whether the host has DO_API_TOKEN set, for the GUI's machine picker —
// the extension can't read process.env itself, so it asks the CLI.
function cmdDoTokenStatus(json: boolean): void {
  const present = !!process.env.DO_API_TOKEN;
  if (json) console.log(JSON.stringify({ present }));
  else console.log(present ? "present" : "absent");
}

/** Pure — the part the test pins. Non-secrets from stored-or-default; secrets never leave the keychain, only whether one is set. */
export function maskConfigView(
  schema: ConfigField[] | undefined,
  stored: Record<string, ConfigVal> | undefined,
  hasSecretFn: (key: string) => boolean
): Record<string, ConfigVal | "set" | "unset"> {
  const out: Record<string, ConfigVal | "set" | "unset"> = {};
  for (const f of schema ?? []) {
    if (f.type === "secret") {
      out[f.key] = hasSecretFn(f.key) ? "set" : "unset";
      continue;
    }
    if (stored && f.key in stored) out[f.key] = stored[f.key];
    else if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

async function findMiner(home: string, netuid: number, persona: string): Promise<MinerEntry | undefined> {
  return (await readState(home)).miners.find((m) => m.netuid === netuid && m.persona === persona);
}

async function cmdConfigGet(netuid: number, persona: string, json: boolean): Promise<void> {
  const home = fezHome();
  const [descriptors, entry] = await Promise.all([loadDescriptors(home), findMiner(home, netuid, persona)]);
  const schema = descriptors.find((d) => d.netuid === netuid)?.config;
  const view = maskConfigView(schema, entry?.config, (k) => getSecret(netuid, persona, k) !== undefined);
  if (json) console.log(JSON.stringify(view));
  else for (const [k, v] of Object.entries(view)) console.log(`${k}\t${v}`);
}

// The state (non-secret) branch used to require an existing MinerEntry —
// `start` was the only thing that created one, which forced the GUI's
// New-miner flow into start → config set → stop → start just to get
// config committed before the real run, double-provisioning a Lium pod
// every time. A fresh (netuid,persona) now gets a stopped stub instead of
// an error; `cmdStart`'s register+upsert (upsertMiner merges by key)
// fills in the real hotkey/uid and flips desired to "running" without
// losing the config this wrote. `config unset`/`thread set-root` keep
// requiring a real entry — nothing writes those before a first start.
export async function cmdConfigSet(netuid: number, persona: string, key: string, value: string, secret: boolean): Promise<void> {
  if (secret) { setSecret(netuid, persona, key, value); return; }
  const home = fezHome();
  await updateState(home,s => {
    const entry = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    const base: MinerEntry = entry ?? { netuid, persona, hotkey: "", desired: "stopped" };
    return upsertMiner(s, { ...base, config: { ...base.config, [key]: value } });
  });
}

// No --secret flag here — a caller may not know where a key landed, so this
// clears BOTH possible locations (keychain + state config); whichever one
// actually held it goes away, the other is a no-op.
async function cmdConfigUnset(netuid: number, persona: string, key: string): Promise<void> {
  deleteSecret(netuid, persona, key);
  const home = fezHome();
  await updateState(home,s => {
    const entry = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    if (!entry?.config || !(key in entry.config)) return;
    const { [key]: _omit, ...rest } = entry.config;
    return upsertMiner(s, { ...entry, config: rest });
  });
}

// The GUI's New-miner picker needs a subnet's config schema before it can
// render the form — this is that schema, straight off the loaded
// descriptor. `--json` is the only shape (nothing to eyeball here).
async function cmdDescribe(netuid: number): Promise<void> {
  const d = (await loadDescriptors(fezHome())).find((x) => x.netuid === netuid);
  if (!d) throw new Error(`no descriptor for netuid ${netuid}`);
  console.log(JSON.stringify({ netuid: d.netuid, name: d.name, network:d.network, mode:d.submission ? "submission" : "process", submissionNotice:d.submission?.notice, requirements: d.requirements, config: d.config }));
}

/** Pure — the part the test pins. Last `n` lines of `text`, in order. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing "\n"
  return lines.slice(-n).join("\n");
}

// The GUI's thread-view card tails this for its log panel. `miner-child.log`
// (a descriptor's own subprocess, when it has one) takes priority over
// `miner.log` (the runner's own bookkeeping — see run.ts's localDir); most
// descriptors only ever write the latter. Prints nothing (not an error) when
// neither file exists yet — a miner that hasn't logged anything, not a bug.
async function cmdLogs(netuid: number, persona: string, lines: number): Promise<void> {
  const dir = path.join(fezHome(), "mining", `${netuid}-${persona}`);
  const childLog = path.join(dir, "miner-child.log");
  const file = existsSync(childLog) ? childLog : path.join(dir, "miner.log");
  if (existsSync(file)) console.log(tailLines(readFileSync(file, "utf8"), lines));
  // Container descriptors also run on the machine itself — append the
  // container's own stdout after the local tail. ssh (owned) hosts only:
  // a lium entry with no live pod would otherwise make resolveMachine
  // PROVISION A FRESH POD just to read logs (its lium branch has no
  // reattach-only mode) — the same billing trap `stop` avoids above.
  const home = fezHome();
  const entry = await findMiner(home, netuid, persona);
  if (entry?.machine?.kind !== "ssh") return;
  const descriptor = (await loadDescriptors(home)).find((d) => d.netuid === netuid);
  if (!descriptor?.container) return;
  try {
    const { machine } = await resolveMachine(entry, persona, {});
    const remote = await containerLogs(machine, netuid, persona, lines);
    console.log("--- container ---");
    console.log(remote);
  } catch {
    // Best-effort — local tail already printed above.
  }
}

// GUI calls this right after posting the #mining root message; the headless
// side reads it back to know where to reply. One-liner upsert.
async function cmdThreadSetRoot(netuid: number, persona: string, root: string, channelId?: string): Promise<void> {
  const home = fezHome();
  await updateState(home,s => {
    const entry = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    if (!entry) throw new Error(`no recorded miner ${netuid}:${persona}`);
    return upsertMiner(s, { ...entry, threadRootId: root, threadChannelId: channelId });
  });
}

function usage(): never {
  console.error(
    "fez-mine subnets [--refresh] | cost --netuid N | metagraph --netuid N --persona P | start --netuid N --persona P [--machine lium | --machine ssh --host user@host[:port] [--ssh-key path] [--serve-port N] | --machine do [--serve-port N]] | stop --netuid N --persona P | status [--json] | machines [--json] | balance [--json] | do-token-status [--json] | " +
      "config get --netuid N --persona P [--json] | config set --netuid N --persona P --key K --value V [--secret] | config unset --netuid N --persona P --key K | " +
      "thread ensure --netuid N --persona P --channel <channelId> | thread set-root --netuid N --persona P --root <eventId> | describe --netuid N --json | " +
      "logs --netuid N --persona P [--lines 12] | submission status|register|test|submit --netuid N --persona P [--file path.py] [--sha256 tested-hash] [--json] | development inspect|configure|evaluate --netuid N --persona P [--repository /path/repo --source agent.py] [--json]"
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const refresh = argv.includes("--refresh");
  const netuidFlag = argv.indexOf("--netuid");
  const netuidValue = netuidFlag >= 0 ? Number(argv[netuidFlag + 1]) : undefined;
  const personaFlag = argv.indexOf("--persona");
  const personaValue = personaFlag >= 0 ? argv[personaFlag + 1] : undefined;
  const machineFlag = argv.indexOf("--machine");
  const machineValue = machineFlag >= 0 ? argv[machineFlag + 1] : undefined;
  if (machineValue !== undefined && machineValue !== "lium" && machineValue !== "ssh" && machineValue !== "do") usage();
  const hostFlag = argv.indexOf("--host");
  const hostValue = hostFlag >= 0 ? argv[hostFlag + 1] : undefined;
  const sshKeyFlag = argv.indexOf("--ssh-key");
  const sshKeyValue = sshKeyFlag >= 0 ? argv[sshKeyFlag + 1] : undefined;
  const servePortFlag = argv.indexOf("--serve-port");
  const servePortValue = servePortFlag >= 0 ? Number(argv[servePortFlag + 1]) || undefined : undefined;
  // `--machine ssh` with no --host is legal on a RESTART — cmdStart
  // reuses the entry's recorded host, same as lium reuses its pod.
  const secret = argv.includes("--secret");
  const keyFlag = argv.indexOf("--key");
  const keyValue = keyFlag >= 0 ? argv[keyFlag + 1] : undefined;
  const valueFlag = argv.indexOf("--value");
  const valueValue = valueFlag >= 0 ? argv[valueFlag + 1] : undefined;
  const rootFlag = argv.indexOf("--root");
  const rootValue = rootFlag >= 0 ? argv[rootFlag + 1] : undefined;
  const linesFlag = argv.indexOf("--lines");
  const linesValue = linesFlag >= 0 ? Number(argv[linesFlag + 1]) || 12 : 12;
  const optionValue = (flag: string): string | undefined => {
    const i=argv.indexOf(flag);
    if (i < 0) return undefined;
    const value=argv[i+1];
    if (!value || value.startsWith("--") || argv.lastIndexOf(flag) !== i) throw Error(`${flag} needs one value`);
    return value;
  };
  const fileValue=optionValue("--file");
  const shaValue=optionValue("--sha256");
  const repositoryValue=optionValue("--repository");
  const sourceValue=optionValue("--source");
  const [cmd, sub] = argv.filter(
    (a, i) =>
      a !== "--json" &&
      a !== "--refresh" &&
      a !== "--secret" &&
      a !== "--repository" && !(argv.indexOf("--repository") >= 0 && i === argv.indexOf("--repository")+1) &&
      a !== "--source" && !(argv.indexOf("--source") >= 0 && i === argv.indexOf("--source")+1) &&
      a !== "--file" && !(argv.indexOf("--file") >= 0 && i === argv.indexOf("--file")+1) &&
      a !== "--sha256" && !(argv.indexOf("--sha256") >= 0 && i === argv.indexOf("--sha256")+1) &&
      a !== "--netuid" &&
      !(netuidFlag >= 0 && i === netuidFlag + 1) &&
      a !== "--persona" &&
      !(personaFlag >= 0 && i === personaFlag + 1) &&
      a !== "--machine" &&
      !(machineFlag >= 0 && i === machineFlag + 1) &&
      a !== "--key" &&
      !(keyFlag >= 0 && i === keyFlag + 1) &&
      a !== "--value" &&
      !(valueFlag >= 0 && i === valueFlag + 1) &&
      a !== "--root" &&
      !(rootFlag >= 0 && i === rootFlag + 1) &&
      a !== "--lines" &&
      !(linesFlag >= 0 && i === linesFlag + 1) &&
      a !== "--host" &&
      !(hostFlag >= 0 && i === hostFlag + 1) &&
      a !== "--ssh-key" &&
      !(sshKeyFlag >= 0 && i === sshKeyFlag + 1) &&
      a !== "--serve-port" &&
      !(servePortFlag >= 0 && i === servePortFlag + 1)
  );

  switch (cmd) {
    case "development": {
      if(netuidValue===undefined||!personaValue||!['inspect','configure','evaluate','evaluate-worker'].includes(sub??''))usage();
      const options={repository:repositoryValue,source:sourceValue};
      if(sub==='evaluate-worker'){await runDevelopmentEvaluation(netuidValue,personaValue,options);break;}
      const result=sub==='evaluate'?await startDevelopmentEvaluation(netuidValue,personaValue,options,path.resolve(process.argv[1]))
        :await developmentCommand(sub as 'inspect'|'configure',netuidValue,personaValue,options);
      console.log(JSON.stringify(result));
      break;
    }
    case "submission": {
      if (netuidValue === undefined || !personaValue || !["status","register","test","submit"].includes(sub ?? "")) usage();
      const result = await submissionCommand(sub as SubmissionAction,netuidValue,personaValue,{file:fileValue,sha256:shaValue},fezHome(),WALLET_BIN);
      console.log(JSON.stringify(result));
      break;
    }
    case "subnets":
      await cmdSubnets(json, refresh);
      break;
    case "cost":
      if (netuidValue === undefined) usage();
      cmdCost(netuidValue);
      break;
    case "metagraph":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdMetagraph(netuidValue, personaValue);
      break;
    case "start":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdStart(
        netuidValue,
        personaValue,
        json,
        machineValue as "lium" | "ssh" | "do" | undefined,
        machineValue === "ssh" && hostValue
          ? { target: hostValue, keyPath: sshKeyValue, servePort: servePortValue }
          : machineValue === "do"
            ? { servePort: servePortValue }
            : undefined
      );
      break;
    case "stop":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdStop(netuidValue, personaValue, json);
      break;
    case "status":
      await cmdStatus(json);
      break;
    case "machines":
      await cmdMachines(json);
      break;
    case "balance":
      await cmdBalance(json);
      break;
    case "do-token-status":
      cmdDoTokenStatus(json);
      break;
    case "config":
      if (netuidValue === undefined || !personaValue) usage();
      switch (sub) {
        case "get":
          await cmdConfigGet(netuidValue, personaValue, json);
          break;
        case "set":
          if (!keyValue || !valueValue) usage();
          await cmdConfigSet(netuidValue, personaValue, keyValue, valueValue, secret);
          break;
        case "unset":
          if (!keyValue) usage();
          await cmdConfigUnset(netuidValue, personaValue, keyValue);
          break;
        default:
          usage();
      }
      break;
    case "thread": {
      if (netuidValue === undefined || !personaValue) usage();
      const i = argv.indexOf("--channel");
      const channelId = i >= 0 ? argv[i+1] : undefined;
      if (sub === "ensure" && channelId) {
        const relayAt=argv.indexOf("--relay");
        const relay=relayAt>=0 ? argv[relayAt+1] : undefined;
        console.log(JSON.stringify({rootId:await ensureMinerThread(fezHome(),netuidValue,personaValue,channelId,undefined,relay)}));
      } else if (sub === "set-root" && rootValue) {
        await cmdThreadSetRoot(netuidValue,personaValue,rootValue,channelId);
      } else usage();
      break;
    }
    case "describe":
      if (netuidValue === undefined) usage();
      await cmdDescribe(netuidValue);
      break;
    case "logs":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdLogs(netuidValue, personaValue, linesValue);
      break;
    default:
      usage();
  }
}

// bin entry — run only when INVOKED, not when imported (tests import
// statusRows from this module). Same realpath-both-sides guard as
// src/run.ts: under the ~/.fez/bin symlink, import.meta.url is the real
// file while argv[1] is the link.
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
const invoked = (() => {
  try {
    return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
  } catch {
    return process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  }
})();
if (invoked && import.meta.url === invoked) {
  main().then(
    () => process.exit(0), // @polkadot/api's websocket (via allSubnets) keeps the event
    // loop alive otherwise — same fix as fez-wallet/src/cli.ts.
    (e) => {
      console.error(`fez-mine: ${(e as Error).message}`);
      process.exit(1);
    }
  );
}
