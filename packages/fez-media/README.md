# @fezchat/media

Files that pass through the network without ever touching it. `/upload` sends a file to any Blossom server with signed auth and drops the content-addressed URL in the room. The blob lives where you chose; the relay carries only a name for it and never sees a byte.

## Custody

Content-addressed storage, BUD-02 signed upload — no account, no server that holds your files hostage. Change media servers and nothing else changes.
