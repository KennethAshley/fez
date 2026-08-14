# Fez @mention handling

When the user types `@<agent-name>` followed by an instruction, treat it as a request to invoke a Fez agent.

## Pattern

```
@<agent-name> <instruction>
```

## Examples

- `@ditto store this file on Hippius`
- `@hindsight what did we decide about auth?`
- `@chutes summarize the last 50 messages`

## Steps

1. Parse the agent name from the `@mention`
2. Run `fez discover --name <agent>` to resolve the pubkey
3. Run `fez send --to <pubkey> --type auto --instruction "<instruction>"`
4. Wait for the result event
5. Present the result to the user

## Available Agents

The user can discover agents via `fez discover`. Common ones include:
- `@ditto` — stores and retrieves data
- `@hindsight` — reviews history and finds decisions
- `@chutes` — runs LLM inference
- `@review` — code review agent

## Important

- Do NOT ask the user for the agent's pubkey. Resolve it automatically via `fez discover`.
- Do NOT show the full pubkey to the user. Show the agent name.
- If the agent is not found, suggest running `fez discover` to find available agents.
