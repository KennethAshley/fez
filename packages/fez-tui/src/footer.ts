import chalk from "chalk";

const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}
function resetScrollRegion(): string {
  return "\x1b[r";
}
function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}
function clearLine(): string {
  return "\x1b[K";
}

/**
 * A persistent one-line status bar pinned to the bottom of the terminal,
 * independent of normal scrollback — the rendering surface extensions plug
 * into (matches how pi's extensions publish segments via ctx.ui.setStatus(),
 * e.g. github.com/nicobailon/pi-powerline-footer).
 *
 * Built on the terminal scroll-region escape (DECSTBM), the same category
 * of technique as the Spinner's \r+clear-line redraw: pure stdout writes,
 * never raw mode, never touches stdin. Constrains normal scrolling
 * (console.log, readline's own prompt) to the region above the footer, so
 * the footer survives untouched while everything else scrolls normally.
 *
 * Real terminal-rendering behavior — verify live in an actual interactive
 * terminal, not just by inspecting the emitted escape sequences. A piped/
 * non-TTY capture (this whole session's usual verification method) can
 * confirm the right bytes are sent but can't confirm a terminal emulator
 * actually renders the split region correctly.
 */
export class Footer {
  private segments = new Map<string, string>();
  private active = false;
  private rows = process.stdout.rows ?? 24;
  private onResize = () => this.handleResize();

  start(): this {
    if (this.active || !process.stdout.isTTY) return this;
    this.active = true;
    this.rows = process.stdout.rows ?? 24;
    process.stdout.write(setScrollRegion(1, this.rows - 1));
    process.stdout.write(moveTo(this.rows - 1, 1)); // put the cursor back in the scrollable region
    process.stdout.on("resize", this.onResize);
    this.render();
    return this;
  }

  private handleResize(): void {
    if (!this.active) return;
    this.rows = process.stdout.rows ?? this.rows;
    process.stdout.write(setScrollRegion(1, this.rows - 1));
    this.render();
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

  private render(): void {
    if (!this.active || !process.stdout.isTTY) return;
    const text = Array.from(this.segments.values()).join(chalk.dim(" │ "));
    process.stdout.write(SAVE_CURSOR + HIDE_CURSOR);
    process.stdout.write(moveTo(this.rows, 1) + clearLine());
    process.stdout.write(chalk.dim(text));
    process.stdout.write(RESTORE_CURSOR + SHOW_CURSOR);
  }

  stop(): void {
    if (!this.active) return;
    process.stdout.off("resize", this.onResize);
    process.stdout.write(SAVE_CURSOR);
    process.stdout.write(moveTo(this.rows, 1) + clearLine());
    process.stdout.write(resetScrollRegion());
    process.stdout.write(RESTORE_CURSOR);
    this.active = false;
  }
}
