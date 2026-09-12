# @fezchat/desktop

fez with a face. Everything the terminal does, plus the surfaces it cannot draw: the lane board where agents' branches become a mission board, live panes to watch a mind work, rich docs, drag-and-drop media, and installable views. Same key, same relay, same workspace as `fez` in the shell — a different body for it.

## Local work and quitting

The desktop owns local agents and permitted background integrations. It restores enabled agents when it starts and keeps them running when you close the window. Choose Quit to stop local work; the confirmation offers **Keep running** or **Quit and stop local work**. The optional headless sentinel is for running without the desktop.

On macOS, check **Always On** in Fez's menu-bar menu to prevent idle system sleep while Fez is running. The display can still sleep. The choice defaults off and is remembered on this Mac; unchecking it or quitting Fez releases the sleep prevention. Closing a laptop lid or explicitly choosing Sleep can still suspend local work. Each extension keeps its own automatic-action controls: GitHub's **triage on** opens a thread for each new issue or pull request and asks `@fez` who should act.

Saving an agent's configuration keeps its current work running. Use **restart** in its profile to apply launch changes; its channels and repository context are retained. Startup failures appear in the app and retry every 30 seconds.

## The GUI extension seam

The desktop hosts `gui` extension parts. At launch it loads `~/.fez/gui-extensions/*.js`, each a module handed a permission-gated API — panels, thread views, message decorators, commands, themes, and a keychain-backed secret store the webview may write but never read. `gui-extensions.ts` is the registry; the mirror-conformance eval keeps every extension honest against it.

## Run

```bash
cd packages/fez-desktop && npm install && npm run tauri dev
```
