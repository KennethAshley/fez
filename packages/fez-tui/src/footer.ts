import chalk from "chalk";
import { Text, type TUI } from "@earendil-works/pi-tui";

/**
 * A persistent one-line status bar — the rendering surface extensions
 * plug into via ui.setStatus() (matches how pi's extensions publish
 * segments, e.g. github.com/nicobailon/pi-powerline-footer).
 *
 * Third incarnation of this file, and the first one that isn't fighting
 * anything: the two previous versions (DECSTBM scroll regions, then
 * relative-cursor ANSI redraws — see git history) both existed to keep a
 * pinned line alive *around* Node's readline, which owned stdin and drew
 * wherever it pleased. Now that the TUI owns the whole terminal through
 * pi-tui's render loop, the footer is just a Text component placed at the
 * bottom of the layout — no cursor math, no console.log patching, no
 * ownership contention at all.
 *
 * setStatus(key, value) is the stable public contract (FezExtensionAPI's
 * ui.setStatus delegates here) — it must not change shape, whatever the
 * rendering engine underneath does.
 */
export class Footer {
  private segments = new Map<string, string>();
  private view = new Text("");
  private tui?: TUI;

  /**
   * Bind to the live TUI and return the component to place in the layout
   * (the caller decides where — bottom of the screen, below the editor).
   * setStatus() calls made before attach (e.g. by an extension during its
   * own init) are kept and shown once attached.
   */
  attach(tui: TUI): Text {
    this.tui = tui;
    this.refresh();
    return this.view;
  }

  detach(): void {
    this.tui = undefined;
  }

  /** Publish or update a named status segment. The extension API's ui.setStatus() calls this. */
  setStatus(key: string, value: string): void {
    if (value) {
      this.segments.set(key, value);
    } else {
      this.segments.delete(key);
    }
    this.refresh();
  }

  private refresh(): void {
    const text = Array.from(this.segments.values()).join(chalk.dim(" │ "));
    this.view.setText(chalk.dim(text));
    this.tui?.requestRender();
  }
}
