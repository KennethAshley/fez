# @fezchat/extension-api

The contract you build a fez extension against.

A fez extension is a package that extends one or more **surfaces**, each
with its own host and its own injected API:

| surface | runs in | you add |
|---|---|---|
| `headless` | the TUI + sentinel | slash commands, scheduled tasks |
| `gui` | the desktop webview | panels, thread views, message cards |
| `relay` | the relay process | HTTP handlers, NIP-11 advertisements |
| `workspace` | the agent runtime | a `repo:` persona's checkout |

Import only the surface you extend:

```ts
import type { FezExtensionAPI } from "@fezchat/extension-api/headless";
import type { GuiExtensionApi } from "@fezchat/extension-api/gui";
```

These are **types only** — they erase at bundle time, so your shipped
part carries no runtime dependency on fez. The host injects the real API
when it loads your part; you type against this so the compiler holds you
to the real contract.

## The shape of an extension

```jsonc
// package.json
{
  "name": "@you/fez-something",
  "fez": {
    "type": "extension",
    "parts": {
      "headless": "dist/headless.js",   // → ~/.fez/extensions
      "gui": "dist/gui.js"              // → ~/.fez/gui-extensions
    },
    "permissions": ["commands", "ui", "read:channels"]
  }
}
```

Each part is a bundled file with a default export the host calls with
the injected API. `fez install @you/fez-something` (or `fez link .` for
local dev) places every part; the host loads the ones it recognizes.

`@fez/git` is the worked example — it uses every surface.
