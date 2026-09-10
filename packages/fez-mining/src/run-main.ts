#!/usr/bin/env node
import { runMiner } from "./run.js";

const [netuid, persona] = process.argv.slice(2);
if (!netuid || !persona || !Number.isInteger(Number(netuid))) {
  console.error("usage: fez-mine-run <netuid> <persona>");
  process.exit(2);
}
runMiner(Number(netuid), persona).then(
  code => process.exit(code),
  error => { console.error(error.message); process.exit(1); },
);
