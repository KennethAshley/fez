# fez-desktop

The fez GUI (#30): Tauri 2 shell + React over the same headless
`@fez/client` brain the TUI uses. The Rust side is ~40 lines (keychain
identity read); everything else is web code with hot reload.

```bash
npm run tauri dev      # dev window against ws://localhost:7777
VITE_FEZ_RELAY=wss://your-relay npm run tauri dev
npm run tauri build    # .app bundle
```

Identity comes from the macOS keychain (`fez keygen` / `fez pair`), the
relay connection is a plain WebSocket from the webview (NIP-42 auth
answered automatically), and joined/scope state persists in
localStorage via @fez/client's persistence seam.
