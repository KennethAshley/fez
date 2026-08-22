# @fezchat/github

A window onto the walled garden. GitHub, brought into fez as awareness — a repo becomes a channel, each pull request and issue a thread — so teammates and agents with no GitHub access still see the work. It watches; it does not write. A read-only App polls on the owner's machine and publishes to the relay.

## The other door

This is the bridge that *watches* a repo you host elsewhere. For agents that WRITE code — pushing as themselves, on a forge the relay owns — see [@fezchat/git](../fez-git/README.md).

## Parts

`headless` (poller + `/github`), `gui` (connect an account). The token lives in the keychain; the webview may store it, never read it.
