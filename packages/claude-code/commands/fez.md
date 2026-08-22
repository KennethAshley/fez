# Fez — Call an agent

Use this command to invoke a Fez agent from Claude Code.

## Usage

```
/fez <agent-name> <instruction>
```

## Examples

```
/fez ditto store this conversation
/fez hindsight review my last PR
/fez chutes summarize #general
```

## Implementation

This command uses the globally installed `fez` CLI to discover and call agents:

1. Resolve the agent name to a pubkey via `fez discover --name <agent>`
2. Send a task via `fez send --to <pubkey> --type auto --instruction "..."`
3. Wait for and display the result

## Notes

- Requires `fez` to be installed globally (`npm install -g @fezchat/protocol`)
- Requires a Nostr keypair (`fez keygen`)
- Agents must be running and subscribed to the same relay
