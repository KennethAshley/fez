import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getActiveTheme } from "./theme.js";

/**
 * Full-height sidebar surface — pi-atelier's dock, both halves now:
 * the renderDock MECHANICS (emit exactly `getHeight()` rows every
 * render, each padded to width and painted with the pane background,
 * so the sidebar reads as one continuous surface) and its VISUAL
 * language (each section is a crowned, rounded box:
 *
 *   ╭─ 🏠 COMMUNITIES ────────╮
 *   │ Web3Builders            │
 *   │ └─ ▸ #general 10        │
 *   ╰─────────────────────────╯
 *
 * dim borders, accent titles, one quiet row between boxes). Sections
 * come from ui.createSidePanel({title, icon}) — untitled sections
 * render as plain rows for back-compat.
 */

export interface SidePanelSectionMeta {
  title?: string;
  icon?: string;
  /** Display position — lower renders higher. Defaults to insertion order (0, 1, 2, …), so an explicit order can slot a section below later-registered ones. */
  order?: number;
}

const BOLD = (s: string) => `\x1b[1m${s}\x1b[22m`;

export class SidePanel implements Component {
  private sections: { meta: SidePanelSectionMeta; text: string }[] = [];

  constructor(
    private getHeight: () => number,
    // Defaults to the ACTIVE theme's pane tint, resolved per render — a
    // theme switch repaints the sidebar on the next frame.
    private bg: (s: string) => string = (s) => getActiveTheme().sidebarBg(s)
  ) {}

  addSection(meta: SidePanelSectionMeta = {}): number {
    this.sections.push({ meta: { ...meta, order: meta.order ?? this.sections.length }, text: "" });
    return this.sections.length - 1;
  }

  setSection(index: number, text: string): void {
    if (this.sections[index]) this.sections[index].text = text;
  }

  /** pi-tui cache hook — this component recomputes every render, nothing to drop. */
  invalidate(): void {}

  render(width: number): string[] {
    const theme = getActiveTheme();
    const dim = theme.dim;
    const accent = theme.accent;
    const inner = Math.max(1, width - 4); // "│ " … " │"
    const rows: string[] = [];

    const ordered = [...this.sections].sort((a, b) => (a.meta.order ?? 0) - (b.meta.order ?? 0));
    for (const { meta, text } of ordered) {
      if (!text.trim() && !meta.title) continue;
      if (rows.length > 0) rows.push("");

      if (meta.title) {
        // ╭─ 🏠 TITLE ──────╮  — crown line, atelier-style.
        const label = `${meta.icon ? `${meta.icon} ` : ""}${meta.title.toUpperCase()}`;
        const fill = Math.max(0, width - 5 - visibleWidth(label));
        rows.push(dim("╭─ ") + BOLD(accent(label)) + dim(` ${"─".repeat(fill)}╮`));
      } else {
        rows.push(dim(`╭${"─".repeat(Math.max(0, width - 2))}╮`));
      }

      for (const line of text.split("\n")) {
        const clipped = truncateToWidth(line, inner, "");
        const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
        rows.push(dim("│ ") + clipped + pad + dim(" │"));
      }

      rows.push(dim(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
    }

    // Exactly terminal-height rows, every one padded and painted — the
    // continuous-surface invariant this component exists for.
    const height = Math.max(1, this.getHeight());
    const sized = rows.slice(0, height);
    while (sized.length < height) sized.push("");
    return sized.map((row) => {
      const clipped = truncateToWidth(row, width, "");
      const pad = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
      return this.bg(clipped + pad);
    });
  }
}
