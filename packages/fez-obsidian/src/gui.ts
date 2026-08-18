/**
 * fez-obsidian, gui part — loaded by fez-desktop's gui-extension loader.
 * Registers the "obsidian" theme (pick it in settings → appearance) and
 * a viewer for `obsidian-note` artifacts. Uses api.React so the page
 * has exactly one React.
 */

interface GuiApi {
  React: {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
  };
  registerTheme(name: string, vars: Record<string, string>): void;
  registerArtifactViewer(type: string, viewer: (props: { artifact: { title?: string; content?: string } }) => unknown): void;
}

export default function activate(api: GuiApi): void {
  const { createElement: h } = api.React;

  api.registerTheme("obsidian", {
    "--bg0": "#1e1e2e",
    "--bg1": "#262637",
    "--bg2": "#363652",
    "--bg-mine": "#2d2d4a",
    "--fg": "#dcddde",
    "--fg-dim": "#8b8ba7",
    "--accent": "#a882ff",
    "--green": "#4caf7d",
    "--red": "#fb464c",
    "--yellow": "#e0ac00",
  });

  api.registerArtifactViewer("obsidian-note", ({ artifact }) =>
    artifact.content
      ? h(
          "div",
          { className: "md", style: { borderLeft: "3px solid #a882ff", paddingLeft: 12 } },
          artifact.title ? h("h3", null, `🟣 ${artifact.title}`) : null,
          h("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "inherit" } }, artifact.content)
        )
      : null
  );
}
