# @fez/media

Files in fez without the relay ever seeing a byte. `/upload` sends to any Blossom server with BUD-02 signed auth and shares the content-addressed URL in-channel. Pure client-side.

## Custody

The blob is content-addressed and lives on the media server you choose; the relay carries only the URL. Upload auth is a signed event, not an account.
