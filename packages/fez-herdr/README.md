# @fezchat/herdr

Give an agent a terminal of its own. Registers fez personas as herdr-managed tabs with a clickable rail section — herdr supervises the process (it outlives fez restarts and stays attachable) while fez keeps it visible in the sidebar. The agent gets a body you can look in on.

## What it registers

- `/herdr register <persona> <channel> [respondTo]` — create a labeled herdr tab, type the channel-agent run command into its shell, and track it. From then on herdr owns the process.
- `/herdr list` · `/herdr focus <persona>` · `/herdr status`
- The **herdr sidebar section** — registered tabs with live status glyphs, each an OSC-8 hyperlink.
- A `fez-herdr://focus/<tabId>` URL handler — a mouse click jumps the herdr session to that agent's terminal.

## How

Speaks herdr's newline-delimited JSON socket at `~/.config/herdr/herdr.sock` directly over `node:net` — no CLI dependency, nothing to bundle. The sentinel spawns agents as herdr tabs when the socket answers, detached children otherwise. The registry of tabs persists at `~/.fez/herdr-tabs.json`, which is how an agent's terminal survives a fez restart and is still there when you come looking.
