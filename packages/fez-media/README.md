# @fezchat/media

Files that pass through the network without ever touching it. `/upload` sends a file to any Blossom server with signed auth and drops the content-addressed URL in the room. The blob lives where you chose; the relay carries only a name for it and never sees a byte.

## What it registers

- `/upload <path>` — sign a kind-24242 BUD-02 authorization naming the blob's sha256, push the file to the configured Blossom server (up to 100 MB), and post the content-addressed URL into the current channel.

That's the whole surface. The server is whatever you point `FEZ_MEDIA_SERVER` (or `mediaServer` in `~/.fez/settings.json`) at — public or self-hosted, defaulting to `blossom.primal.net`.

## Custody

Content-addressed storage, BUD-02 signed upload — no account, no server that holds your files hostage. The client signs, any Blossom server verifies and stores. Change media servers and nothing else changes: the same bring-your-own posture as relay storage.
