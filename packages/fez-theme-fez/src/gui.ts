/**
 * fez — the theme.
 *
 * DESIGN PLAN
 *
 * Gruvbox medium, wearing fez's ember.
 *
 * This started as the landing page: pure black, one hot orange, the
 * Blade Runner 2049 argument that a room should have a single light
 * source. It looked the part and was tiring to live in — near-zero
 * separation between grounds means every boundary is carried by a
 * hairline, and hours of chat on #000 is not what the site's hero
 * image was solving for.
 *
 * So the grounds are gruvbox MEDIUM (#282828) — one step of light off
 * the app's default hard #1d2021, which is the variant people who live
 * in gruvbox actually pick — and the ember stays as the accent. That is
 * the whole idea: everything structural is gruvbox, and the one colour
 * you notice is fez's own.
 *
 * Two decisions worth naming:
 *
 * 1. --accent IS --brand here. App.css keeps them apart on purpose so
 *    that changing the palette never drags the mark with it; on THIS
 *    theme that separation has nothing to protect, because the app is
 *    deliberately wearing the brand.
 *
 * 2. --phosphor is gruvbox green, NOT the ember. Selection wears ember
 *    across the whole app now (the notch in the rail, in settings, in
 *    search), so an agent WORKING must not paint itself the same colour
 *    as an agent SELECTED. Two signals, two hues.
 *
 * Chart marks are validated, not chosen: the ok/fail pair passes the
 * colourblind-separation and contrast checks against each mode's own
 * surface (deutan ΔE 8.5 on night, 10.0 on day).
 *
 * Day is not an inversion. #FF6A00 on paper is about 2.5:1 — unreadable
 * as text — so the accent darkens to #C24A00 while the mark keeps more
 * of its heat, because a mark is a shape and prose is not.
 */

/**
 * Nostalgic-future faces first, degrading to the system stack. None is
 * a dependency — an absent face falls through silently, and the app was
 * already monospace throughout.
 */
const FACE =
  '"Berkeley Mono", "IBM Plex Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

type ThemeVars = Record<string, string>;

interface ThemeApi {
  registerTheme(name: string, vars: { light: ThemeVars; dark: ThemeVars }): void;
}

export default function activate(api: ThemeApi): void {
  api.registerTheme("fez", {
    /** NIGHT — the landing page itself. */
    dark: {
      // Gruvbox medium (#282828), not the hard #1d2021 the app's default
      // ships — one step of light off the page, which is what makes the
      // long sessions comfortable.
      "--bg0": "#282828",
      "--field": "#282828",
      "--bg1": "#32302f",
      "--bg2": "#3c3836",
      // Your own words, lit from inside — the one place the accent
      // touches a surface instead of text.
      "--bg-mine": "#32281f",
      "--fg": "#ebdbb2",
      "--fg-dim": "#a89984",
      // The ember IS this theme. Everything else is gruvbox; this is
      // the part that makes it fez.
      "--accent": "#FF6A00",
      "--green": "#b8bb26",
      "--red": "#fb4934",
      "--yellow": "#fabd2f",
      "--brand": "#FF6A00",
      // The rail sits a step deeper than the page (gruvbox hard).
      "--bg-rail": "#1d2021",
      "--hairline": "#45403d",
      // Live stays gruvbox green, NOT the ember: selection wears ember
      // everywhere in this app now, and an agent working must not read
      // as an agent selected.
      "--phosphor": "#b8bb26",
      // CVD-validated against #282828 (deutan ΔE 8.5, contrast pass).
      "--viz-ok": "#43a56c",
      "--viz-fail": "#fb4934",
      "--font-mono": FACE,
    },

    /**
     * DAY — not an inversion.
     *
     * The one thing that MUST change is the amber. #FF6A00 on paper is
     * about 2.5:1, so as body text or an active-channel label it is
     * unreadable. It darkens to #C24A00 (~4.6:1 on this ground) and
     * stays unmistakably the same colour. The mark keeps more of its
     * heat than the text accent does, because it is a shape, not prose.
     */
    light: {
      "--bg0": "#fbf1c7",
      "--field": "#fbf1c7",
      "--bg1": "#f2e5bc",
      "--bg2": "#ebdbb2",
      "--bg-mine": "#f6e0bf",
      "--fg": "#3c3836",
      "--fg-dim": "#7c6f64",
      // #FF6A00 on paper is ~2.5:1 — unreadable as text. It darkens and
      // stays unmistakably the same colour; the mark keeps more heat
      // than the text accent, because it is a shape, not prose.
      "--accent": "#c24a00",
      "--green": "#79740e",
      "--red": "#9d0006",
      "--yellow": "#b57614",
      "--brand": "#d45500",
      "--bg-rail": "#f2e5bc",
      "--hairline": "#d5c4a1",
      "--phosphor": "#79740e",
      // CVD-validated against #fbf1c7 (deutan ΔE 10.0, contrast pass).
      "--viz-ok": "#79740e",
      "--viz-fail": "#9d0006",
      "--font-mono": FACE,
    },
  });
}
