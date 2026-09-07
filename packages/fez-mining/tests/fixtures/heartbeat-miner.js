// The conformance fixture: a SubnetMiner[] module with observable verbs.
import fs from "node:fs/promises";
import path from "node:path";

export default [
  {
    netuid: 9999,
    name: "heartbeat",
    async install(ctx) {
      await fs.writeFile(path.join(ctx.workDir, "installed"), "1");
    },
    async register(ctx) {
      await fs.writeFile(path.join(ctx.workDir, "enrolled"), ctx.hotkey);
    },
    async start(ctx) {
      ctx.log("beating");
      await fs.writeFile(path.join(ctx.workDir, "heartbeat"), String(Date.now()));
      // resolves immediately — a real miner blocks here
    },
  },
];
