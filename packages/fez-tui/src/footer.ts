import chalk from "chalk";

const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";

/**
 * A persistent one-line status bar trailing the bottom of normal output —
 * the rendering surface extensions plug into (matches how pi's extensions
 * publish segments via ctx.ui.setStatus(), e.g.
 * github.com/nicobailon/pi-powerline-footer).
 *
 * Two earlier versions of this file didn't work, for two different
 * reasons, both worth recording:
 *
 * 1. The original used the DECSTBM scroll-region escape (`\x1b[top;bottomr`)
 *    plus absolute row addressing (`moveTo(rows, 1)`) to pin the footer to
 *    the terminal's literal bottom row. Checked against
 *    @earendil-works/pi-tui (the dependency this package replaced, see
 *    packages/fez-tui/README.md) and it never uses DECSTBM or absolute row
 *    addressing anywhere — its non-fullscreen renderer tracks its own
 *    cursor row and redraws with purely relative moves. Live-tested here:
 *    DECSTBM silently no-ops in the terminal actually used to verify this
 *    (no crash, no visible scroll-region effect at all), so normal output
 *    scrolled straight over the footer's absolute-addressed row.
 *
 * 2. The relative-move rewrite fixed that, but introduced a logic bug:
 *    it hid the footer before every `rl.prompt()` call and only re-showed
 *    it on the next write, meaning the footer was invisible for the exact
 *    state a user actually looks at — idle at an empty prompt. Confirmed
 *    live via stderr instrumentation: render() was being called with the
 *    right text throughout, the footer's own writes just never survived
 *    to the steady state because of that hide-before-prompt call.
 *
 * Current design: render() is a single self-contained operation — save
 * the cursor, drop a line, clear it, write the footer text, restore the
 * cursor to exactly where it was (SAVE_CURSOR/RESTORE_CURSOR, the same
 * primitive 340e3fe already validated live for surviving a scroll). This
 * needs no state tracking (no "is the footer currently printed" flag) and
 * no special-casing for the prompt: the footer always sits one line below
 * wherever the cursor legitimately is, and repainting it is idempotent.
 * Console.log is patched (only while active) to call render() again after
 * every write, since a normal write's own trailing newline naturally
 * reclaims whatever line the footer was previously painted on — nothing
 * needs to clear it first.
 */
export class Footer {
  private segments = new Map<string, string>();
  private active = false;
  private originalConsoleLog = console.log;

  start(): this {
    if (this.active || !process.stdout.isTTY) return this;
    this.active = true;
    console.log = (...args: unknown[]) => {
      this.originalConsoleLog.apply(console, args);
      this.render();
    };
    this.render();
    return this;
  }

  /** Publish or update a named status segment. The extension API's ui.setStatus() calls this. */
  setStatus(key: string, value: string): void {
    if (value) {
      this.segments.set(key, value);
    } else {
      this.segments.delete(key);
    }
    if (this.active) this.render();
  }

  /** Paint the footer one line below the cursor's current position, then restore the cursor exactly. Safe to call any time the footer is active — self-contained, no state to get out of sync. */
  render(): void {
    if (!this.active || !process.stdout.isTTY) return;
    const text = Array.from(this.segments.values()).join(chalk.dim(" │ "));
    process.stdout.write(SAVE_CURSOR + "\n\r\x1b[2K" + chalk.dim(text) + RESTORE_CURSOR);
  }

  stop(): void {
    if (!this.active) return;
    process.stdout.write(SAVE_CURSOR + "\n\r\x1b[2K" + RESTORE_CURSOR);
    console.log = this.originalConsoleLog;
    this.active = false;
  }
}
