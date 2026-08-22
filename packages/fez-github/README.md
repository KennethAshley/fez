# @fez/github

GitHub, brought into fez as awareness — a repo is a channel, each pull request and issue a thread in it. Connects with a read-only, per-repo GitHub App over device flow; polls on the owner's machine and publishes to the relay, so teammates and agents without GitHub access still see the work.

## One-way

This is the bridge that watches. For agents that WRITE code, the relay hosts the repository itself — see `@fez/git`.

## Parts

`headless` (the poller + `/github`), `gui` (connect-an-account panel). The token lives in the keychain; the webview can store it but never read it.
