# @fezchat/obsidian

Your vault, joined to the network — three ways from one package. `/obsidian` exports channel docs to the vault (headless), agents get vault access through `mcp-obsidian` (skill), and the desktop wears an Obsidian-flavored theme (gui). The worked example of a multi-part extension, from before @fezchat/git existed.

## What it registers

Three parts, one `fez install`:

- **headless** — `/obsidian` exports the current channel's doc to the vault, `/obsidian <name>` under a custom note name, `/obsidian vault <path>` sets where the vault lives (persisted in `~/.fez/obsidian.json`; `FEZ_OBSIDIAN_VAULT` overrides; default `~/Obsidian`). Notes land in `<vault>/fez/<name>.md`.
- **skill** — the `mcp-obsidian` server, run via `npx`, so agents read and write the vault directly. Needs `OBSIDIAN_API_KEY` (Obsidian's Local REST API plugin).
- **gui** — the `obsidian` theme (pick it in settings → appearance) and a viewer for `obsidian-note` artifacts.

Permissions: `read:channels`, `commands`, `ui`.

## Parts

`skill` (the MCP server), `headless` (the export), `gui` (the theme + viewer). One `fez install` places them all.
