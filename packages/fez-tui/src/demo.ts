#!/usr/bin/env node
import chalk from "chalk";
import { Container, Loader, Markdown, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { Footer } from "./footer.js";
import { loaderColors, markdownTheme } from "./theme.js";

/**
 * Standalone smoke test for the pi-tui-backed stack — run it in a real
 * terminal before trusting the production wiring in src/tui.ts. Renders
 * the same beats as a real session: header, a user message, a live
 * loader, a markdown reply, the footer. Exits by itself; never reads
 * stdin, so it can't hang a non-interactive runner.
 */
async function main() {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, false);
  const log = new Container();
  const footer = new Footer();
  tui.addChild(log);
  tui.addChild(footer.attach(tui));
  tui.start();

  footer.setStatus("relay", "wss://relay.damus.io");
  footer.setStatus("demo", "fez-tui smoke test");

  log.addChild(new Text(chalk.bold.magenta("Fez") + "\nWelcome to Fez! 🧢 (fez-tui demo)"));
  tui.requestRender();
  await sleep(600);

  log.addChild(new Text("\n" + chalk.bold.blue("You") + "\nWhat's the plan for the auth refactor?"));
  tui.requestRender();
  await sleep(600);

  const loader = new Loader(tui, loaderColors.spinner, loaderColors.message, "@researcher is thinking...");
  log.addChild(loader);
  loader.start();
  await sleep(1500);
  loader.stop();
  log.removeChild(loader);

  log.addChild(new Text("\n" + chalk.bold.green("@researcher")));
  log.addChild(
    new Markdown(
      [
        "## Auth refactor plan",
        "",
        "1. Replace session cookies with **short-lived JWTs**",
        "2. Add a `refreshToken` rotation endpoint",
        "3. Migrate existing sessions with a background job",
        "",
        "> Ship behind a feature flag — don't cut over all at once.",
      ].join("\n"),
      0,
      0,
      markdownTheme
    )
  );
  tui.requestRender();
  await sleep(1500);

  tui.stop();
  console.log(chalk.dim("\n(demo complete)"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
