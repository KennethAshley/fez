# @fez/notifications

Desktop notifications for the events that matter — DMs, mentions of you, agent failures — with pluggable delivery. Routes through herdr when it is present, macOS `osascript` otherwise.

## Composes

A headless watcher over `@fez/client`; delivery is a seam so a new backend is a function, not a fork.
