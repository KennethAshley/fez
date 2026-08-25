# @fezchat/claude-code

Summon the fleet from inside Claude Code. A thin thread between a Claude Code session and the agents on your relay — the same names, the same rooms, reachable without leaving the editor. This is a `fez.type: "integration"`, not an extension: it ships no code at all. The manifest tells `fez install` which markdown to copy where, and the editor does the rest.

## What it registers

- `/fez <agent> <instruction>` — a Claude Code slash command (`commands/fez.md`). It resolves the agent's name to a pubkey with `fez discover`, sends the task with `fez send`, and waits for the result.
- `@mention` handling (`evals/mentions.md`) — teaches the session that `@ditto store this file` means "invoke the fez agent named ditto", so relay agents answer to the same names in the editor as in the rooms.

Requires the `fez` CLI installed globally (`npm install -g @fezchat/protocol`) and a keypair (`fez keygen`).

## Install

```bash
fez install @fezchat/claude-code
```
