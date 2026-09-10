#!/usr/bin/env node
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import {
  cmdInit, cmdDerive, cmdFund, cmdStatus, cmdNetwork, initWallet, derivePersona,
  cmdRegister, cmdPersonaStatus, cmdPayout, cmdCost, cmdMetagraph, registerPersona, stakePersona, unstakePersona, personaStatus, payoutPersona, payFromTreasury, registrationCost, metagraphInfo,
  exportRemoteHotkey,
} from "./cli-commands.js";
import { rentAgent, payAddress } from "./rent.js";
import { escrowOpen, escrowApprove, escrowStatus } from "./stake.js";
import { burnRun, burnStatus, FEE_RATE, BURN_VAULT } from "./fees.js";

const io = { print: (l: string) => console.log(l) };
const argv = process.argv.slice(2);
// --json: the same ceremony, machine-shaped — the wallet panel's in-app
// init/derive flow parses this instead of scraping prose.
const json = argv.includes("--json");
const existing = argv.includes("--existing");
const requireTestnet = argv.includes("--require-testnet");
// --netuid N: which subnet the stake-rehearsal verbs act on (default 553).
const netuidFlag = argv.indexOf("--netuid");
const netuidValue = netuidFlag >= 0 ? Number(argv[netuidFlag + 1]) : undefined;
const netuidArg = (): number | undefined => {
  if (netuidValue === undefined) return undefined;
  if (!Number.isInteger(netuidValue) || netuidValue < 0) throw new Error("--netuid must be a whole number");
  return netuidValue;
};
const asFlag = argv.indexOf("--as");
const marketFlag = argv.indexOf("--market");
// --hotkey <ss58>: register's remote-hotkey override (Task 5/7) — registers
// that address instead of deriving one from a local persona pair.
const hotkeyFlag = argv.indexOf("--hotkey");
const [cmd, ...rest] = argv.filter((a, i) =>
  a !== "--json" && a !== "--existing" && a !== "--require-testnet" && a !== "--netuid" && !(netuidFlag >= 0 && i === netuidFlag + 1)
  && a !== "--as" && !(asFlag >= 0 && i === asFlag + 1)
  && a !== "--market" && !(marketFlag >= 0 && i === marketFlag + 1)
  && a !== "--hotkey" && !(hotkeyFlag >= 0 && i === hotkeyFlag + 1));

try {
  if (requireTestnet && cmd !== "metagraph") throw new Error("--require-testnet is supported only by metagraph");
  await cryptoWaitReady();
  const adapter = () => substrateAdapter({ endpoint: loadConfig().endpoints.tao });
  switch (cmd) {
    case "capabilities":
      io.print(JSON.stringify({ existingHotkey: true, metagraphRequireTestnet: true }));
      break;
    case "init":
      if (json) console.log(JSON.stringify(await initWallet()));
      else await cmdInit(io);
      break;
    case "derive":
      if (!rest[0]) throw new Error("usage: fez-wallet derive <persona>");
      if (json) console.log(JSON.stringify(await derivePersona(rest[0])));
      else await cmdDerive(io, rest[0]);
      break;
    case "fund":
      if (!rest[0] || !rest[1]) throw new Error("usage: fez-wallet fund <persona> <amount>");
      await cmdFund(io, adapter(), rest[0], rest[1]);
      break;
    case "status":
      // `status <persona>` is the chain-read the stake GUI renders from;
      // bare `status` stays the whole-wallet balance sweep it always was.
      if (rest[0]) {
        if (json) console.log(JSON.stringify(await personaStatus(rest[0], netuidArg())));
        else await cmdPersonaStatus(io, rest[0], netuidArg());
      } else {
        await cmdStatus(io, adapter());
      }
      break;
    case "register": {
      if (!rest[0]) throw new Error("usage: fez-wallet register <persona> [--netuid 553] [--hotkey <ss58>]");
      const hotkeyAddress = hotkeyFlag >= 0 ? argv[hotkeyFlag + 1] : undefined;
      const registerOpts = hotkeyAddress ? { hotkeyAddress } : undefined;
      if (json) console.log(JSON.stringify(await registerPersona(rest[0], netuidArg(), registerOpts)));
      else await cmdRegister(io, rest[0], netuidArg(), registerOpts);
      break;
    }
    case "cost":
      if (json) console.log(JSON.stringify(await registrationCost(netuidArg())));
      else await cmdCost(io, netuidArg());
      break;
    case "metagraph": {
      const hotkey = hotkeyFlag >= 0 ? argv[hotkeyFlag + 1] : undefined;
      const netuid = netuidArg();
      if (!hotkey || netuid === undefined) throw new Error("usage: fez-wallet metagraph --netuid N --hotkey <ss58> [--json] [--require-testnet]");
      if (json) console.log(JSON.stringify((await metagraphInfo(netuid, hotkey, requireTestnet)) ?? {}));
      else await cmdMetagraph(io, netuid, hotkey, requireTestnet);
      break;
    }
    case "export-hotkey": {
      if (!rest[0]) throw new Error("usage: fez-wallet export-hotkey <persona> [--existing] [--json]");
      const r = await exportRemoteHotkey(rest[0], { existing });
      if (json) console.log(JSON.stringify(r));
      else io.print(`${r.created ? "created" : "loaded"} remote hotkey for ${r.persona}: ${r.ss58Address}`);
      break;
    }
    case "stake":
      if (!rest[0] || !rest[1]) throw new Error("usage: fez-wallet stake <persona> <amount>");
      if (json) console.log(JSON.stringify(await stakePersona(rest[0], rest[1], netuidArg())));
      else {
        const r = await stakePersona(rest[0], rest[1], netuidArg());
        io.print(`staked ${r.amount} tTAO to ${r.persona}'s own hotkey on netuid ${r.netuid} (tx ${r.txHash})`);
      }
      break;
    case "unstake":
      if (!rest[0] || !rest[1]) throw new Error("usage: fez-wallet unstake <persona> <amount>");
      if (json) console.log(JSON.stringify(await unstakePersona(rest[0], rest[1], netuidArg())));
      else {
        const r = await unstakePersona(rest[0], rest[1], netuidArg());
        io.print(`unstaked ${r.amount} tα from ${r.persona} on netuid ${r.netuid} (tx ${r.txHash})`);
      }
      break;
    case "rent": {
      // rent <minerPk> <hours> --as <persona> [--market wss://…]
      const asIdx = argv.indexOf("--as");
      const marketIdx = argv.indexOf("--market");
      const asPersona = asIdx >= 0 ? argv[asIdx + 1] : undefined;
      if (!rest[0] || !rest[1] || !asPersona) throw new Error("usage: fez-wallet rent <miner pubkey hex> <hours> --as <persona> [--market wss://…]");
      const r = await rentAgent(asPersona, rest[0], Number(rest[1]), marketIdx >= 0 ? argv[marketIdx + 1] : undefined);
      if (json) console.log(JSON.stringify(r));
      else io.print(`${r.persona} rented ${r.miner.slice(0, 8)} for ${r.hours}h — paid ${r.amount} tTAO (tx ${r.txHash}); the tick receipt is on the market relay`);
      break;
    }
    case "pay": {
      // pay <address> <amount> --as <persona> [--for <eventId>] [--to-pk <npub>]
      const asIdx = argv.indexOf("--as"); const forIdx = argv.indexOf("--for"); const toPkIdx = argv.indexOf("--to-pk");
      const who = asIdx >= 0 ? argv[asIdx+1] : undefined;
      if (!rest[0] || !rest[1] || !who) throw new Error("usage: fez-wallet pay <address> <amount> --as <persona|treasury> [--for <eventId>] [--to-pk <npub>]");
      // treasury is the human's main account — signed by the root, so it
      // routes through cli-commands (never the root-free persona pay).
      const r = who === "treasury"
        ? await payFromTreasury(adapter(), rest[0], rest[1], {})
        : await payAddress(who, rest[0], rest[1], { forEvent: forIdx>=0?argv[forIdx+1]:undefined, payeePk: toPkIdx>=0?argv[toPkIdx+1]:undefined });
      io.print(json ? JSON.stringify(r) : `${r.persona} paid ${r.amount} tTAO to ${r.to.slice(0,8)}… (tx ${r.txHash})`);
      break;
    }
    case "payout":
      if (!rest[0]) throw new Error("usage: fez-wallet payout <persona> [amount]");
      if (json) console.log(JSON.stringify(await payoutPersona(rest[0], rest[1], netuidArg())));
      else await cmdPayout(io, rest[0], rest[1], netuidArg());
      break;
    case "escrow": {
      // escrow open <worker> <arbiter> <amount> --as <persona>
      // escrow release|refund <poster> <worker> <arbiter> <amount> --as <persona>
      // escrow status <poster> <worker> <arbiter>
      const asIdx = argv.indexOf("--as");
      const who = asIdx >= 0 ? argv[asIdx + 1] : undefined;
      const sub = rest[0];
      if (sub === "open") {
        if (!who || !rest[1] || !rest[2] || !rest[3]) throw new Error("usage: fez-wallet escrow open <worker> <arbiter> <amount> --as <persona>");
        const r = await escrowOpen(who, rest[1], rest[2], rest[3]);
        io.print(json ? JSON.stringify(r) : `escrow opened at ${r.escrow} — funded ${rest[3]} tTAO (tx ${r.txHash}); the worker can verify the money before working`);
      } else if (sub === "release" || sub === "refund") {
        if (!who || !rest[1] || !rest[2] || !rest[3] || !rest[4]) throw new Error(`usage: fez-wallet escrow ${sub} <poster> <worker> <arbiter> <amount> --as <persona>`);
        const r = await escrowApprove(who, rest[1], rest[2], rest[3], rest[4], sub === "release" ? "worker" : "poster");
        io.print(json ? JSON.stringify(r) : (r.executed ? `escrow ${sub}d — funds moved (tx ${r.txHash})` : `approval recorded — one more of the three must ${sub} to move the funds (tx ${r.txHash})`));
      } else if (sub === "status") {
        if (!rest[1] || !rest[2] || !rest[3]) throw new Error("usage: fez-wallet escrow status <poster> <worker> <arbiter>");
        const r = await escrowStatus(rest[1], rest[2], rest[3]);
        io.print(json ? JSON.stringify(r) : `escrow ${r.escrow} holds ${r.heldTao} tTAO`);
      } else {
        throw new Error("usage: fez-wallet escrow open|release|refund|status …");
      }
      break;
    }
    case "burn": {
      // burn            — what the till holds (accrued fees, pool price)
      // burn run [amt]  — buy alpha from the pool and DESTROY it, one
      //                   extrinsic (addStakeBurn). The fee burn's back half.
      if (rest[0] === "run") {
        const r = await burnRun(rest[1], netuidArg());
        io.print(json ? JSON.stringify(r) : `burned ${r.burnedTao} tTAO worth of alpha on netuid ${r.netuid} (tx ${r.txHash}) — bought from the pool and destroyed`);
      } else {
        const s = await burnStatus(netuidArg());
        io.print(json ? JSON.stringify({ ...s, feeRate: FEE_RATE }) : `the till (${BURN_VAULT} ${s.vault.slice(0, 8)}…) holds ${s.accruedTao} tTAO of fees${s.alphaPriceTao !== undefined ? ` · alpha at ${s.alphaPriceTao.toFixed(6)} tТАО` : ""} · fee rate ${(FEE_RATE * 100).toFixed(1)}%`);
      }
      break;
    }
    case "network":
      await cmdNetwork(io, rest[0]);
      break;
    default:
      io.print("fez-wallet — per-agent allowance wallets");
      io.print("  capabilities --json     read-only: supported wallet safety guards");
      io.print("  init                    create the master wallet (once)");
      io.print("  derive <persona>        create an agent's allowance account");
      io.print("  fund <persona> <amt>    treasury → agent (TAO)");
      io.print("  status [persona]        balances — with a persona: uid + free + staked");
      io.print("  register <persona> [--hotkey <ss58>]   register on the subnet (treasury pays the burn); --hotkey registers a remote address instead of deriving one");
      io.print("  cost [--netuid 553]     read-only: what registering would burn, before paying it");
      io.print("  metagraph --netuid N --hotkey <ss58> [--json] [--require-testnet]   read-only: live miner performance; optional guard requires the exact testnet endpoint");
      io.print("  export-hotkey <persona> [--existing] [--json]   export a remote-signing key; --existing refuses missing keys; --json includes the secret keyfile");
      io.print("  stake <persona> <amt>   the agent stakes to its own hotkey");
      io.print("  unstake <persona> <amt> symmetric");
      io.print("  payout <persona> [amt]  sweep earned alpha from the treasury to the agent's own name");
      io.print("  rent <minerPk> <hours> --as <persona>   pay another agent's hourly rate from a persona's allowance");
      io.print("  escrow open|release|refund|status …      2-of-3 escrow for a hire (no custodian)");
      io.print("  network [test|finney]   show or switch which chain you're on");
      process.exitCode = cmd ? 1 : 0;
  }
  process.exit(process.exitCode ?? 0); // polkadot ws keeps the loop alive otherwise
} catch (e) {
  console.error(`fez-wallet: ${(e as Error).message}`);
  process.exit(1);
}
