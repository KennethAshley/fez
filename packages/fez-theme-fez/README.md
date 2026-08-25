# @fezchat/theme-fez

The look, worn by the app. The landing page's own palette on every surface: black ground, one ember (`#FF6A00`), monospace throughout. Restraint as a design — one accent, everything else quiet. The nostalgia is in the monospace and the restraint, not in scanlines or phosphor cosplay.

## What it registers

- The `fez` theme — a single `gui` part, one `registerTheme("fez", ...)` call with a light and a dark variant. Pick it in settings → appearance.

Nothing else. No commands, no views, no state; `ui` is its only permission.

## How

Wells, hairlines, surfaces, and the one accent are theme tokens, so every extension inherits the look without shipping a line of CSS. The dark variant is the landing page — enormous darkness with a single amber source in it; the light variant keeps the same bones in daylight. Swap themes and every extension follows, because none of them ever knew a color by name.
