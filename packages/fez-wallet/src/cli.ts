#!/usr/bin/env node
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import {
  cmdInit, cmdDerive, cmdFund, cmdStatus, cmdNetwork, initWallet, derivePersona,
  cmdRegister, cmdPersonaStatus, cmdPayout, registerPersona, stakePersona, unstakePersona, personaStatus, payoutPersona,
} from "./cli-commands.js";

const io = { print: (l: string) => console.log(l) };
const argv = process.argv.slice(2);
// --json: the same ceremony, machine-shaped — the wallet panel's in-app
// init/derive flow parses this instead of scraping prose.
const json = argv.includes("--json");
// --netuid N: which subnet the stake-rehearsal verbs act on (default 553).
const netuidFlag = argv.indexOf("--netuid");
const netuidValue = netuidFlag >= 0 ? Number(argv[netuidFlag + 1]) : undefined;
const netuidArg = (): number | undefined => {
  if (netuidValue === undefined) return undefined;
  if (!Number.isInteger(netuidValue) || netuidValue < 0) throw new Error("--netuid must be a whole number");
  return netuidValue;
};
const [cmd, ...rest] = argv.filter((a, i) => a !== "--json" && a !== "--netuid" && !(netuidFlag >= 0 && i === netuidFlag + 1));

try {
  await cryptoWaitReady();
  const adapter = () => substrateAdapter({ endpoint: loadConfig().endpoints.tao });
  switch (cmd) {
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
    case "register":
      if (!rest[0]) throw new Error("usage: fez-wallet register <persona> [--netuid 553]");
      if (json) console.log(JSON.stringify(await registerPersona(rest[0], netuidArg())));
      else await cmdRegister(io, rest[0], netuidArg());
      break;
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
    case "payout":
      if (!rest[0]) throw new Error("usage: fez-wallet payout <persona> [amount]");
      if (json) console.log(JSON.stringify(await payoutPersona(rest[0], rest[1], netuidArg())));
      else await cmdPayout(io, rest[0], rest[1], netuidArg());
      break;
    case "network":
      await cmdNetwork(io, rest[0]);
      break;
    default:
      io.print("fez-wallet — per-agent allowance wallets");
      io.print("  init                    create the master wallet (once)");
      io.print("  derive <persona>        create an agent's allowance account");
      io.print("  fund <persona> <amt>    treasury → agent (TAO)");
      io.print("  status [persona]        balances — with a persona: uid + free + staked");
      io.print("  register <persona>      register on the subnet (treasury pays the burn)");
      io.print("  stake <persona> <amt>   the agent stakes to its own hotkey");
      io.print("  unstake <persona> <amt> symmetric");
      io.print("  payout <persona> [amt]  sweep earned alpha from the treasury to the agent's own name");
      io.print("  network [test|finney]   show or switch which chain you're on");
      process.exitCode = cmd ? 1 : 0;
  }
  process.exit(process.exitCode ?? 0); // polkadot ws keeps the loop alive otherwise
} catch (e) {
  console.error(`fez-wallet: ${(e as Error).message}`);
  process.exit(1);
}
