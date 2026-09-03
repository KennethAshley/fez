/** `fez reset --factory` — identity, ~/.fez, desktop storage, gone. */
import type { Command } from "commander";
import chalk from "chalk";

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Reset local fez state (--factory: identity + agent keys, ~/.fez, desktop storage — irreversible)")
    .option("--factory", "the full wipe — this machine has never seen fez afterward")
    .option("--yes", "skip the typed confirmation (scripts)")
    .action(async (options: { factory?: boolean; yes?: boolean }) => {
      if (!options.factory) {
        console.error('fez reset only knows one depth: "fez reset --factory". Nothing was touched.');
        process.exitCode = 1;
        return;
      }
      const { factoryResetPlan, executeFactoryReset, fezProcessesRunning } = await import("../identity/reset.js");

      // A running app (or a fez-spawned agent) re-writes state on exit —
      // wiping underneath it produces the half-reset this command exists
      // to prevent. Refuse rather than race; there is no flag for this.
      const running = fezProcessesRunning();
      if (running.length > 0) {
        console.error(`quit fez first — still running: ${running.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const plan = factoryResetPlan();
      console.log(chalk.red("factory reset removes, irreversibly:"));
      for (const dir of plan.dirs) console.log(`  ${dir}`);
      if (plan.keychainServices.length > 0) {
        console.log(`  every keychain entry under: ${plan.keychainServices.join(", ")} — your identity AND your agents' keys`);
      }
      console.log(chalk.dim("a deleted key cannot be reissued — `fez keys export` first if this identity matters"));
      console.log(chalk.dim("this includes the WALLET ROOT: if the treasury holds funds, back up the 24 words first\n"));

      if (!options.yes) {
        const { default: inquirer } = await import("inquirer");
        const { confirm } = await inquirer.prompt<{ confirm: string }>([
          { type: "input", name: "confirm", message: 'type "reset" to confirm:' },
        ]);
        if (confirm.trim() !== "reset") {
          console.log("nothing touched.");
          return;
        }
      }

      const { removed, keysDeleted } = executeFactoryReset(plan);
      console.log(chalk.green(`✓ factory reset — ${keysDeleted} key ${keysDeleted === 1 ? "entry" : "entries"} deleted, ${removed.length} director${removed.length === 1 ? "y" : "ies"} removed`));
      console.log("the next fez launch (app or CLI) starts from nothing.");
    });
}
