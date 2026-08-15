import chalk from "chalk";
import { Spinner } from "./spinner.js";
import { renderMarkup } from "./markup.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(chalk.bold.magenta("Fez"));
  console.log("Welcome to Fez! 🧢 (fez-tui demo — no pi-tui, no raw mode)");

  console.log();
  console.log(chalk.bold.blue("You"));
  console.log("What's the plan for the auth refactor?");

  console.log();
  const spinner = new Spinner("@researcher is thinking...").start();
  await sleep(800);
  spinner.setText("@researcher: Replacing session cookies with short-l...");
  await sleep(800);
  spinner.setText("@researcher: ...JWTs, adding a refreshToken rotation...");
  await sleep(800);
  spinner.stop();

  console.log(chalk.bold.green("@researcher"));
  console.log(
    renderMarkup(
      [
        "Here's the plan:",
        "",
        "1. Replace session cookies with **short-lived JWTs**",
        "2. Add a `refreshToken` rotation endpoint",
        "3. Migrate existing sessions with a background job",
        "",
        "```ts",
        "function rotate(token: string) { /* ... */ }",
        "```",
      ].join("\n")
    )
  );

  console.log();
  console.log(chalk.dim("(demo complete — this whole thing never touched process.stdin)"));
}

main();
