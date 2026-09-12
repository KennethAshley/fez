# Extension migration

Approved direction: Fez renders standard settings and dialogs from bounded data. Custom extension interfaces run in an isolated child view inside the same window. Preserve existing capabilities and recorded grants; do not execute extension JavaScript in the main app as a fallback.

- [x] Replace Kanban's clipped details dialog with a host-owned full-window overlay; verify focus, Escape, resize, cleanup, and grant revocation.
- [x] Convert Themes to data and preserve all 19 palettes exactly.
- [x] Convert Browser and ElevenLabs settings to host-rendered data; preserve setup, status, voice preferences, and previews.
- [x] Migrate Mining, Bazaar, and Wallet custom surfaces with scoped host operations; prepare retirement of the obsolete installed Ridges GUI while preserving its installed backend attachments.
- [x] Run typechecks, the eval gate, native tests, browser checks, and an actual macOS probe; stage, sign, notarize, and install the complete update.

Do not mutate live boards, send messages, launch real agent jobs, or make payments during verification. Bazaar's source checkout is dirty and differs from the installed version; preserve both before staging its update. Wallet process authority includes seed operations and must be disclosed accurately rather than described as a complete executable sandbox.
