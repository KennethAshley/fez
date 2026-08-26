# Agent single ownership — one live instance per persona

**Date:** 2026-08-26 · **Status:** draft for review · **Scope:** the guard only; spawn-path consolidation (managed_agents vs summoner) remains its own workstream

## Problem

Nothing enforces that a persona runs once. Found live (2026-08-26): @scout and
@quill each ran twice — desktop-spawned and terminal-spawned (herdr tabs,
plus a sentinel launchd service that predated the demotion) — and every
mention got two answers. Each spawner is individually correct; the system has
no shared notion of "already alive."

## Decision

Ownership is decided at the **relay**, not the spawner: the persona's own
presence heartbeat is the lock. Any spawner may try; the instance itself
yields when the persona is already alive somewhere.

Two layers, both cheap:

1. **Spawner courtesy check** — before spawning, a host (summoner, managed
   agents, TUI, sentinel) queries presence for the persona's stable key. A
   heartbeat fresher than `TTL` (propose 90s; heartbeats every 30s) means
   don't spawn. This avoids most duplicate *processes* but is advisory —
   racing spawners can both pass it.
2. **Boot-time yield (the actual guard)** — on start, an instance subscribes
   to its own key's presence before announcing. Seeing a live heartbeat
   carrying a different `instance` nonce, it exits with a distinct code
   ("already running elsewhere") instead of announcing. First-wins; ties
   (both booting, neither announced) break by nonce order, which both sides
   compute identically from the two nonces.

Presence events gain one tag: `instance` (random nonce per process). Same
pubkey + different nonce = another copy of me. No new event kinds.

## Takeover

`fez agent <persona> --take-over` skips the yield and publishes a
`supersede` note in its first heartbeat; running instances seeing a
supersede heartbeat for their key with a different nonce shut down. This is
how "move scout from the terminal to the desktop" works without hunting
PIDs. The desktop's explicit spawn (AgentsPane) uses take-over; implicit
summons never do.

## Non-goals

- Consolidating the desktop's two spawn paths (tracked separately).
- Cross-machine ownership (two laptops, one persona key) — same mechanism
  extends, but heartbeat TTLs over flaky relays need their own review.

## Testing

- Unit: yield decision (fresh vs stale heartbeat, nonce tiebreak, supersede).
- Integration: two `fez agent scout` against one relay — second exits
  "already running"; with `--take-over`, first exits instead.
- E2E gate: mention a persona with an instance already live in another
  surface; exactly one reply.
