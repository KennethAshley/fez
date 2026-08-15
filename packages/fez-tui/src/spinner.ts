import chalk from "chalk";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/**
 * In-place status line via plain ANSI escapes (\r + clear-line), never
 * raw mode, never touches stdin. Same technique ora already used
 * successfully in this codebase — the point of writing our own is
 * dropping the dependency and controlling exactly what gets drawn, not
 * a different rendering strategy. See packages/fez-tui/README.md for
 * why raw-mode-based rendering (the pi-tui attempt) was reverted.
 */
export class Spinner {
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private active = false;

  constructor(private text: string) {}

  start(): this {
    if (this.active) return this;
    this.active = true;
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
    return this;
  }

  setText(text: string): void {
    this.text = text;
    if (this.active) this.render();
  }

  private render(): void {
    process.stdout.write(`\r\x1b[K${chalk.cyan(FRAMES[this.frame])} ${this.text}`);
  }

  private clearLine(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write("\r\x1b[K");
    process.stdout.write("\x1b[?25h"); // show cursor
    this.active = false;
  }

  succeed(finalText?: string): void {
    this.clearLine();
    console.log(chalk.green("✓") + " " + (finalText ?? this.text));
  }

  fail(finalText?: string): void {
    this.clearLine();
    console.log(chalk.red("✗") + " " + (finalText ?? this.text));
  }

  /** Stops without printing a final line — caller prints their own follow-up content. */
  stop(): void {
    this.clearLine();
  }
}
