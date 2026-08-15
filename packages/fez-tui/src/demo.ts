#!/usr/bin/env node
import chalk from "chalk";
import {
  ProcessTerminal,
  TuiMainScreen,
  Container,
  Text,
  Loader,
  Markdown,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

/**
 * Phase 1 proof from packages/fez-tui/README.md: does mounting
 * TuiMainScreen + rendering real Loader/Markdown components actually work,
 * live, in a normal (non-fullscreen) terminal? Not a rewrite of src/tui.ts
 * — a standalone script proving the two integration points the brief
 * identifies before touching production code.
 *
 * Colors below are chalk-based placeholders, not pi's actual dark.json
 * palette — getting exact fidelity to pi's real theme values is a
 * follow-up refinement once the mechanism itself is proven.
 */

const theme: MarkdownTheme = {
  heading: (t) => chalk.bold.yellow(t),
  link: (t) => chalk.cyan.underline(t),
  linkUrl: (t) => chalk.dim(t),
  code: (t) => chalk.cyan(t),
  codeBlock: (t) => t,
  codeBlockBorder: (t) => chalk.dim(t),
  quote: (t) => chalk.dim.italic(t),
  quoteBorder: (t) => chalk.dim(t),
  hr: (t) => chalk.dim(t),
  listBullet: (t) => chalk.cyan(t),
  bold: (t) => chalk.bold(t),
  italic: (t) => chalk.italic(t),
  strikethrough: (t) => chalk.strikethrough(t),
  underline: (t) => chalk.underline(t),
};

async function main() {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, false);
  const log = new Container();
  tui.addChild(log);
  tui.start();

  log.addChild(new Text(chalk.bold.magenta("Fez") + "\n" + "Welcome to Fez! 🧢 (fez-tui demo)"));
  tui.requestRender();
  await sleep(600);

  log.addChild(new Text(chalk.bold.blue("You") + "\nWhat's the plan for the auth refactor?"));
  tui.requestRender();
  await sleep(600);

  const loader = new Loader(
    tui,
    (s) => chalk.cyan(s),
    (s) => chalk.dim(s),
    "@researcher is thinking..."
  );
  log.addChild(loader);
  loader.start();
  tui.requestRender();
  await sleep(1500);

  loader.stop();
  log.removeChild(loader);

  const reply = new Markdown(
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
    theme
  );
  log.addChild(new Text(chalk.bold.green("@researcher")));
  log.addChild(reply);
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
