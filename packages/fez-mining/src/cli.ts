#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import type { MinerEntry } from "./state.js";
import { fezHome, readState, writeState, upsertMiner } from "./state.js";
import { loadDescriptors } from "./descriptors.js";
import { teardownPod } from "./machine-lium.js";
import { alive, kill, spawnDetached } from "./procs.js";

// Both bins resolve via ~/.fez/bin on PATH once installed; these overrides
// let the CLI run straight from dist/ before an install (dev + tests).
const WALLET_BIN = process.env.FEZ_WALLET_BIN || "fez-wallet";
const MINE_RUN_BIN = process.env.FEZ_MINE_RUN_BIN || "fez-mine-run";

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
  return miners.map((m) => ({ ...m, alive: isAlive(m.pid) }));
}

async function cmdSubnets(json: boolean, refresh: boolean): Promise<void> {
  const home = fezHome();
  let s = await readState(home);
  if (refresh) {
    const { allSubnets } = await import("@fezchat/bittensor/subnets");
    const subnets = await allSubnets();
    const covered = (await loadDescriptors(home)).map((d) => d.netuid);
    // The chain fetch above takes multiple seconds; re-read + merge rather
    // than writing the whole (possibly stale) state we read before it, so
    // a stop/runner-exit/sentinel write racing the fetch isn't clobbered
    // (worst case: resurrecting a stopped miner).
    const fresh = await readState(home);
    s = { ...fresh, subnets, covered };
    await writeState(home, s);
  }
  if (json) console.log(JSON.stringify({ subnets: s.subnets, covered: s.covered }));
  else for (const sn of s.subnets) console.log(`${sn.netuid}\t${sn.name}${s.covered.includes(sn.netuid) ? "\t[covered]" : ""}`);
}

function cmdCost(netuid: number): void {
  // Straight passthrough — fez-wallet already shapes {netuid, rao, tao}.
  process.stdout.write(execFileSync(WALLET_BIN, ["cost", "--netuid", String(netuid), "--json"], { encoding: "utf8" }));
}

async function cmdStart(netuid: number, persona: string, json: boolean, machine?: "lium"): Promise<void> {
  const home = fezHome();
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
  // For a lium miner, the signing key lives on the pod, not this
  // keychain — export the standalone remote hotkey first and register
  // ITS address (the Task 5 override), not a locally-derived pair's.
  const registerArgs = ["register", persona, "--netuid", String(netuid), "--json"];
  if (machine === "lium") {
    const exported = JSON.parse(
      execFileSync(WALLET_BIN, ["export-hotkey", persona, "--json"], { encoding: "utf8" })
    ) as { ss58Address: string };
    registerArgs.push("--hotkey", exported.ss58Address);
  }
  const r = JSON.parse(execFileSync(WALLET_BIN, registerArgs, { encoding: "utf8" })) as RegisterResult;
  let s = await readState(home);
  // No podId yet — the runner provisions the pod on first spawn and
  // records it back onto this entry.
  s = upsertMiner(s, {
    netuid, persona, hotkey: r.hotkey, uid: r.uid, desired: "running",
    ...(machine === "lium" ? { machine: { kind: "lium" as const } } : {}),
  });
  await writeState(home, s);
  const pid = spawnDetached(MINE_RUN_BIN, [String(netuid), persona]);
  s = await readState(home);
  const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona)!;
  await writeState(home, upsertMiner(s, { ...cur, pid, startedAt: Date.now(), attention: undefined }));
  if (json) console.log(JSON.stringify({ ...r, pid }));
  else console.log(`started ${persona} on netuid ${netuid} (uid ${r.uid}, pid ${pid})`);
}

async function cmdStop(netuid: number, persona: string, json: boolean): Promise<void> {
  const home = fezHome();
  const s = await readState(home);
  const m = s.miners.find((e) => e.netuid === netuid && e.persona === persona);
  if (m?.pid && alive(m.pid)) kill(m.pid);
  if (m) {
    let machine = m.machine;
    if (machine?.kind === "lium" && machine.podId) {
      try {
        await teardownPod(machine.podId);
      } catch (e) {
        // Best-effort — a pod that's already gone (or a `lium` hiccup)
        // must not block `stop` from recording the desired state.
        console.error(`fez-mine: teardown of pod ${machine.podId} failed: ${(e as Error).message}`);
      }
      machine = { ...machine, podId: undefined };
    }
    await writeState(home, upsertMiner(s, { ...m, desired: "stopped", pid: undefined, machine }));
  }
  if (json) console.log(JSON.stringify({ netuid, persona, stopped: true }));
  else console.log(`stopped ${persona} on netuid ${netuid}`);
}

async function cmdStatus(json: boolean): Promise<void> {
  const rows = statusRows((await readState(fezHome())).miners, alive);
  if (json) console.log(JSON.stringify(rows));
  else for (const row of rows) console.log(`${row.netuid}:${row.persona}\t${row.desired}\t${row.alive ? "alive" : "dead"}`);
}

function usage(): never {
  console.error(
    "fez-mine subnets [--refresh] | cost --netuid N | start --netuid N --persona P [--machine lium] | stop --netuid N --persona P | status [--json]"
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
  if (machineValue !== undefined && machineValue !== "lium") usage();
  const [cmd] = argv.filter(
    (a, i) =>
      a !== "--json" &&
      a !== "--refresh" &&
      a !== "--netuid" &&
      !(netuidFlag >= 0 && i === netuidFlag + 1) &&
      a !== "--persona" &&
      !(personaFlag >= 0 && i === personaFlag + 1) &&
      a !== "--machine" &&
      !(machineFlag >= 0 && i === machineFlag + 1)
  );

  switch (cmd) {
    case "subnets":
      await cmdSubnets(json, refresh);
      break;
    case "cost":
      if (netuidValue === undefined) usage();
      cmdCost(netuidValue);
      break;
    case "start":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdStart(netuidValue, personaValue, json, machineValue as "lium" | undefined);
      break;
    case "stop":
      if (netuidValue === undefined || !personaValue) usage();
      await cmdStop(netuidValue, personaValue, json);
      break;
    case "status":
      await cmdStatus(json);
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
