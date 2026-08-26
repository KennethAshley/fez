#!/usr/bin/env node
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import { cmdInit, cmdDerive, cmdFund, cmdStatus } from "./cli-commands.js";

const io = { print: (l: string) => console.log(l) };
const [cmd, ...rest] = process.argv.slice(2);

try {
  await cryptoWaitReady();
  const adapter = () => substrateAdapter({ endpoint: loadConfig().endpoints.tao });
  switch (cmd) {
    case "init":
      cmdInit(io);
      break;
    case "derive":
      if (!rest[0]) throw new Error("usage: fez-wallet derive <persona>");
      cmdDerive(io, rest[0]);
      break;
    case "fund":
      if (!rest[0] || !rest[1]) throw new Error("usage: fez-wallet fund <persona> <amount>");
      await cmdFund(io, adapter(), rest[0], rest[1]);
      break;
    case "status":
      await cmdStatus(io, adapter());
      break;
    default:
      io.print("fez-wallet — per-agent allowance wallets");
      io.print("  init                    create the master wallet (once)");
      io.print("  derive <persona>        create an agent's allowance account");
      io.print("  fund <persona> <amt>    treasury → agent (TAO)");
      io.print("  status                  balances for treasury + all agents");
      process.exitCode = cmd ? 1 : 0;
  }
  process.exit(process.exitCode ?? 0); // polkadot ws keeps the loop alive otherwise
} catch (e) {
  console.error(`fez-wallet: ${(e as Error).message}`);
  process.exit(1);
}
