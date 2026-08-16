import chalk from "chalk";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/**
 * Full-height sidebar surface — pi-atelier's renderDock pattern: the
 * component emits exactly `getHeight()` rows every render, each padded to
 * the column width and painted with the pane background, so the sidebar
 * reads as a continuous surface from top to bottom of the terminal
 * (content rows or not) instead of a floating patch behind whatever text
 * happens to exist.
 *
 * Sections stack top-down with a blank row between non-empty ones;
 * extensions get a section each via ui.createSidePanel().
 */
export class SidePanel implements Component {
  private sections: string[] = [];

  constructor(
    private getHeight: () => number,
    private bg: (s: string) => string = (s) => chalk.bgAnsi256(236)(s)
  ) {}

  addSection(): number {
    this.sections.push("");
    return this.sections.length - 1;
  }

  setSection(index: number, text: string): void {
    this.sections[index] = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.max(0, this.getHeight());
    if (width <= 0 || height === 0) return [];
    const lines = this.sections
      .filter((s) => s.trim().length > 0)
      .join("\n\n")
      .split("\n");
    return Array.from({ length: height }, (_, i) => {
      const content = truncateToWidth(" " + (lines[i] ?? ""), width, "");
      const pad = " ".repeat(Math.max(0, width - visibleWidth(content)));
      return this.bg(content + pad);
    });
  }
}
