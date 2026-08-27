# Notification sounds

fez ships no audio. These files are licensed to a person (Epidemic Sound
and the like license to you, not to a repository), so they are dropped in
per install rather than committed.

To add one:

1. Put `<name>.mp3` here.
2. Add `<name>` to `SOUND_NAMES` in `../../src/sounds.ts`.

A picker then appears on every category in Settings → notifications, with
a preview button. Until at least one is listed, that section says so
plainly rather than showing an empty picker.

Keep them SHORT — under a second. This plays when you are not looking at
the app, alongside a native banner, and anything longer stops being a
notification and starts being an interruption.
