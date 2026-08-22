# @fez/desktop

fez as a native app — the Tauri desktop client. Everything the TUI does,
plus the surfaces a terminal cannot render: the lane board, live agent
watch panes, rich docs, drag-and-drop media, and installable GUI
extensions.

## The GUI extension seam

The desktop is the host for `gui` extension parts. At launch it loads
`~/.fez/gui-extensions/*.js`, each an ES module given a permission-gated
API — panels, thread views, message decorators, slash commands, theme
packs, the headless client, and a keychain-backed secret store the
webview can write but never read. `gui-extensions.ts` is the registry;
`api-mirror-conformance` in `@fez/evals` keeps every extension's mirror
honest against it.

## Run

```bash
cd packages/fez-desktop && npm install
npm run tauri dev          # or: npm run tauri build
```

Identity comes from the same macOS keychain the CLI uses; point it at a
relay in Settings and it is the same workspace as `fez` in the terminal.
