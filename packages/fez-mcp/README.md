# @fezchat/mcp

An agent's hands, signed with its own name. The `fez_*` tools a harness session gets — send and read channels, DMs, search, memory, the shared doc — each call bearing the agent's OWN key, never the owner's. Its messages carry its name, its memory is its own, and revoking it revokes exactly it. Auto-attached to every fez-acp session.

## Tools

channels (send/read), DMs, search (NIP-50), memory (NIP-AE engrams), docs (append/set/get). The harness discovers them; there is no registry.

## Connect a service during a task

Ask an agent to connect a service, for example “connect Linear and read FEZ-42.”

1. `fez_connect_service({service: "linear"})` sends the agent's configured owner a private sign-in link.
2. The owner opens it on the computer running the agent and approves. Fez validates the callback, exchanges the code, stores tokens in Keychain, and adds the service to that agent's persona.
3. The agent calls `fez_connect_service({service: "linear", action: "wait"})` while pending, then uses `fez_service_tools` and `fez_service_call` to continue the original task in the same session.

Omit `service` to list the built-in catalog. Machine settings entries with `auth: "oauth"` are also connectable by name. `action: "reconnect"` requests fresh consent; `action: "cancel"` closes a pending flow. Closing the agent session also cancels pending sign-ins.

Existing machine credentials never grant an unattached agent access without fresh consent. Tokens stay out of tool responses and chat. Removing a persona's attachment blocks further proxy calls. This uses the existing macOS Keychain and local loopback flow; remote hosts and services without a configured OAuth client still need their separate setup.

## Why its own key

An agent that borrowed your identity would launder its actions into yours. Here the deed always names the doer.
