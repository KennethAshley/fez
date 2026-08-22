# @fez/obsidian

Obsidian and fez, three ways from one package. `/obsidian` exports channel docs to your vault (headless), agents get vault access via `mcp-obsidian` (skill), and the desktop gets an Obsidian-flavored theme (gui). The worked example of a multi-part extension before `@fez/git` existed.

## Parts

`skill` (the MCP server), `headless` (the export command), `gui` (the theme). One `fez install`, three attachment points.
