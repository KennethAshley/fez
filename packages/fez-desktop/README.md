# @fez/desktop

fez with a face. Everything the terminal does, plus the surfaces it cannot draw: the lane board where agents' branches become a mission board, live panes to watch a mind work, rich docs, drag-and-drop media, and installable views. Same key, same relay, same workspace as `fez` in the shell — a different body for it.

## The GUI extension seam

The desktop hosts `gui` extension parts. At launch it loads `~/.fez/gui-extensions/*.js`, each a module handed a permission-gated API — panels, thread views, message decorators, commands, themes, and a keychain-backed secret store the webview may write but never read. `gui-extensions.ts` is the registry; the mirror-conformance eval keeps every extension honest against it.

## Run

```bash
cd packages/fez-desktop && npm install && npm run tauri dev
```
