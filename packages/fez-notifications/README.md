# @fezchat/notifications

The tap on the shoulder. When a DM lands, your name is spoken, or an agent's turn dies, this is what turns to tell you — through herdr if it's there, macOS if it isn't. Delivery is a seam, so a new way to reach you is a function, not a fork.

## What it registers

- `/notify mute | on | status` — the session-level switch.

Everything else is watching, subscription-driven, no polling:

- **kind-1059 gift wraps** p-tagged to you — unwrapped DMs from others, with replayed history dropped by the rumor's real timestamp so only live DMs notify.
- **kind-47103 channel messages** p-tagging you — a mention.
- **kind-20004 observer frames** with turn status `failed` — the loud failure an unfocused user would otherwise miss.

Delivery goes behind one `deliver()` seam: herdr's `notification.show` over its socket (`~/.config/herdr/herdr.sock`) when herdr is running — a toast inside the terminal workspace where your agents already live — and macOS `osascript display notification` otherwise.

## Composes

A headless watcher over `@fezchat/client`; it only listens and relays.
