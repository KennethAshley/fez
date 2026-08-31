# DM bubble unification — one message component, a narrow dm mode

**Date:** 2026-08-30 · **Status:** draft for review · **Scope:** DmView
renders messages through the shared `Bubble` component instead of its own
hand-rolled markup. **Not in scope:** protocol work — reactions, threads,
and pins over gift-wrapped DMs stay future work; this spec only ends the
frontend drift.

## The problem

DMs don't use `Bubble`. `DmView` (App.tsx:~2444-2465) hand-rolls a
bubble: avatar, author, time, `MdBody`, day dividers — and nothing else.
Channel messages go through `Bubble` (App.tsx:~2864), which carries
mention highlighting, media rendering, artifact/proposal/approval/choice
cards, message decorators (the extension seam), hover cards, reactions,
threads, pins, and moderation.

The cost is drift, and it recurs: install-offer cards (2026-08-30) had
to be mounted into DmView by hand because the shared path doesn't reach
DMs. Every future message feature pays the same tax or silently skips
DMs. Ken's observation: DMs "don't seem as full fledged" — because they
render through a fork that predates most message features.

## The split that matters

Two kinds of gap, two different fixes:

- **Frontend-only** (no protocol dependency): mention highlighting
  (`tagged`/`onMention`), media rendering, artifact markers, proposal /
  approval / choice cards, message decorators, git install offers,
  hover cards, consistent chrome. These work over DMs today — the DM
  fork just never mounts them. **This spec.**
- **Protocol-shaped**: reactions, thread replies, pins, moderation all
  reference public event ids; gift-wrapped DMs need a design for that
  (wrapped reaction events, DM-thread addressing). **Explicitly out of
  scope** — `Bubble`'s dm mode hides those affordances.

## Design

`Bubble` gains a `variant?: "channel" | "dm"` prop (default
`"channel"`). In dm mode:

- Hidden: reaction pills + picker, thread/reply affordances, pin
  action and pin mark, moderation actions (withhold/restore/reason),
  anything reading `client.reactions/threadReplyCount/isPinned/
  canModerate` — those calls are simply not made in dm mode (they key
  on channel ids DMs don't have).
- Kept: avatar + HoverCard + author/profile, time, `MdBody` with
  `tagged` mention names and `media`, artifact/install marker
  stripping, proposal/approval/choice cards, message decorators, git
  install offers (moves out of DmView's hand-rolled markup into the
  shared mount, gated `variant === "dm" && !group` for the git card).
- `Msg` adapter: DM messages (`convo.msgs`: senderPk/text/ts/id) map to
  the `Msg` shape `Bubble` expects (authorPk/content/ts/id/authorName/
  mentionPks/media). One small mapping function beside DmView, not a
  new type. DM media share-lines already parse with the same machinery
  the channel path uses — wire `media` through it.

DmView's message map then renders `<Bubble variant="dm" …>` and its
hand-rolled bubble markup is deleted. Day dividers stay in DmView (they
are list concerns, not message concerns — same as the channel timeline).

## Why a variant and not a second component

The drift IS the bug. A `DmBubble` twin would re-create it with a nicer
name. One component, one narrow flag, and every future message feature
lands in DMs by default — an author must *opt out* for channel-only
affordances rather than remember to port.

## Risks

- `Bubble` reads `channelId` for reactions/pins/threads/moderation —
  in dm mode those reads must not run (guard by variant, not by feeding
  a fake channel id; a fake id that "mostly works" is the hack shape).
- Group DMs: everything applies except the git install card (`!group`
  consent rule from the install-from-chat spec stands).

## Testing

- Vitest (jsdom, existing patterns in packages/fez-desktop/tests):
  dm-variant renders mentions highlighted, media, an approval card, and
  a git install offer from a DM-shaped message; and asserts reaction /
  thread / pin affordances are absent in dm mode.
- Manual pass in `tauri dev`: a DM with mentions, an attachment, and an
  install offer reads like a channel message minus reactions/threads.

## Follow-up (separate specs when wanted)

- DM reactions/threads/pins over gift wrap (protocol design first).
- Persona-template refresh for existing installs (the fez.md staleness
  found during install-from-chat's manual gate) — unrelated to Bubble
  but discovered the same night; noted so it isn't lost.
