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
 * Colour — six named values, then three semantics kept deliberately
 * quiet so nothing ever rivals the amber:
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
 * Layout: a theme can only set variables, so the compositional argument
 * here is contrast discipline — near-zero separation between grounds,
 * with every bit of hierarchy carried by weight, spacing and the single
 * amber. That restraint IS the 2049 move; adding a third grey would
 * undo it.
 */

interface ThemeApi {
  registerTheme(name: string, vars: Record<string, string>): void;
}

export default function activate(api: ThemeApi): void {
  api.registerTheme("fez", {
    "--bg0": "#000000",
    "--bg1": "#070707",
    "--bg2": "#17140f",
    // Your own words, lit from inside.
    "--bg-mine": "#1a0d02",
    "--fg": "#e8e2d9",
    "--fg-dim": "#6d645a",
    "--accent": "#FF6A00",
    // Semantics, held back: they must read as status, never as a rival
    // light. Each is desaturated toward the ground it sits on.
    "--green": "#5f8f6a",
    "--red": "#d64545",
    "--yellow": "#c9903a",
    "--brand": "#FF6A00",
    // Nostalgic-future faces first, degrading to the system stack. None
    // is a dependency — an absent face falls through silently, and the
    // app was already monospace throughout.
    "--font-mono":
      '"Berkeley Mono", "IBM Plex Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  });
}
