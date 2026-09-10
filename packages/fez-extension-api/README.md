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

GUI activation can return `Promise<void>`. Finish registrations before
it resolves: the host waits before reporting the extension as loaded.
If activation throws or rejects, its registry changes are rolled back
and the error appears in extension status. Reloads run sequentially and
restore the host registrations before activating the installed set again.
This rollback covers registrations, not external writes or arbitrary
background work started by the extension.

Extensions run as trusted code in their host process. Grants restrict
selected injected APIs; the current client surface is not fully narrowed
by permission, and grants do not sandbox extension code.

`@fezchat/git` is the worked example — it uses every surface.
