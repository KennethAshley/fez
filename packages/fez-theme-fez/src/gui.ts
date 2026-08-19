/**
 * fez — the theme, taken from the landing page.
 *
 * DESIGN PLAN
 *
 * Subject: fez's own front door. `bg-black`, monospace end to end, one
 * hot orange (#FF6A00), roman numerals, "the relay remembers", "a dumb
 * stone that stores what was signed". Esoteric and mythic, and the
 * closest cinematic relative is Blade Runner 2049 — enormous darkness
 * with a single amber source in it, haze, brutalist calm. "Nostalgic
 * future" means the terminal remembered fondly, NOT simulated: no
 * scanlines, no CRT curvature, no green phosphor cosplay. The nostalgia
 * is in the monospace and the restraint.
 *
 * Colour — six named values for night, then three semantics kept
 * deliberately quiet so nothing ever rivals the amber:
 *
 *   #000000  void      the page is literally black; nothing lifts far off it
 *   #070707  chamber   panels separate by LIGHT, not hue (2049's rooms)
 *   #17140f  hairline  warm-shifted from the page's neutral-900
 *   #FF6A00  amber     the one source
 *   #e8e2d9  bone      warm off-white — pure white goes clinical next to amber
 *   #6d645a  dust      warm dim; the site's neutral-600 is cold, and a
 *                      grey with a hue bias toward the accent reads as
 *                      chosen rather than inherited
 *
 * Two decisions worth naming:
 *
 * 1. --accent IS --brand here. App.css keeps them apart on purpose, so
 *    that changing the palette never drags the mark with it. On THIS
 *    theme that separation has nothing to protect: the app is wearing
 *    the brand, and a second accent would be a second light source in a
 *    room whose whole argument is that there is one.
 *
 * 2. --bg-mine is a faint amber pool (#1a0d02) rather than the default's
 *    cool slate. It is the only place the accent touches a SURFACE
 *    instead of text, and it is the right place: in your own room, you
 *    are the thing giving off light.
 *
 * Day/night: the light side is NOT the night palette inverted. 2049 is
 * not only night — the Vegas sequence is amber daylight, the Wallace
 * interiors bone limestone lit warm. Inverting would have produced a
 * cold white sheet with a screaming orange on it.
 *
 * Layout: a theme can only set variables, so the compositional argument
 * here is contrast discipline — near-zero separation between grounds,
 * with every bit of hierarchy carried by weight, spacing and the single
 * amber. That restraint IS the 2049 move; adding a third grey would
 * undo it.
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
      "--bg0": "#000000",
      "--bg1": "#070707",
      "--bg2": "#17140f",
      // Your own words, lit from inside.
      "--bg-mine": "#1a0d02",
      "--fg": "#e8e2d9",
      "--fg-dim": "#6d645a",
      "--accent": "#FF6A00",
      // Semantics, held back: they must read as status, never as a
      // rival light. Each is desaturated toward the ground it sits on.
      "--green": "#5f8f6a",
      "--red": "#d64545",
      "--yellow": "#c9903a",
      "--brand": "#FF6A00",
      // The rail is the deepest room in the house; the hairline does the
      // separating, not a lighter ground.
      "--bg-rail": "#050403",
      "--hairline": "#17140f",
      // The live wire — everything streaming from an agent. It stays
      // amber: a second hue would be a second light source, and the
      // pulse animation already distinguishes it from static text.
      "--phosphor": "#FF6A00",
      "--viz-ok": "#5f8f6a",
      "--viz-fail": "#d64545",
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
      "--bg0": "#f4efe6",
      "--bg1": "#ece5d8",
      "--bg2": "#ddd3c2",
      "--bg-mine": "#fbe6d0",
      "--fg": "#1a1714",
      "--fg-dim": "#6f665d",
      "--accent": "#c24a00",
      "--green": "#4e7a58",
      "--red": "#a52f2f",
      "--yellow": "#8a6420",
      "--brand": "#d45500",
      "--bg-rail": "#e7dfd0",
      "--hairline": "#ddd3c2",
      "--phosphor": "#c24a00",
      "--viz-ok": "#4e7a58",
      "--viz-fail": "#a52f2f",
      "--font-mono": FACE,
    },
  });
}
