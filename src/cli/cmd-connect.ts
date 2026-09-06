import type { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTIONS,
  connectionEntry,
  connectService,
  disconnectService,
  readConnection,
  isStale,
} from "../extensions/connections.js";

/**
 * `fez connect [service]` — sign in, don't paste. No arg lists the
 * catalog with connected state; with a service it runs the browser
 * sign-in and registers the skill so personas can declare it.
 */
export function registerConnectCommands(program: Command): void {
  program
    .command("connect [service]")
    .description("Connect a service by signing in — agents get its MCP tools, no API keys pasted")
    .option("--disconnect", "Forget this connection's tokens")
    .action(async (service: string | undefined, opts: { disconnect?: boolean }) => {
      if (!service) {
        console.log(chalk.bold("connections") + chalk.dim("  — fez connect <service>\n"));
        for (const c of CONNECTIONS) {
          const blob = readConnection(c.key);
          const state = blob?.tokens?.access_token
            ? isStale(blob)
              ? chalk.yellow("● stale (will refresh on use)")
              : chalk.green("● connected")
            : chalk.dim("○ not connected");
          console.log(`  ${c.key.padEnd(10)} ${state}  ${chalk.dim(c.what)}`);
        }
        return;
      }

      const entry = connectionEntry(service);
      if (!entry) {
        console.error(chalk.red(`✗ unknown service "${service}"`) + chalk.dim(` — try: ${CONNECTIONS.map((c) => c.key).join(", ")}`));
        process.exitCode = 1;
        return;
      }

      if (opts.disconnect) {
        disconnectService(service);
        console.log(`✓ ${entry.title} disconnected — tokens forgotten`);
        return;
      }

      console.log(`connecting ${chalk.bold(entry.title)} — your browser will open to sign in…`);
      try {
        await connectService(service);
      } catch (e) {
        console.error(chalk.red(`✗ ${e instanceof Error ? e.message : e}`));
        process.exitCode = 1;
        return;
      }

      // connectService registered the skill in settings itself — every
      // connect surface (CLI, desktop, in-chat) leaves the same state.
      console.log(chalk.green(`✓ ${entry.title} connected`) + ` — tokens in the keychain, refreshed before every use.`);
      console.log(chalk.dim(`  personas declaring mcpServers: [${service}] get it on next spawn.`));
    });
}
