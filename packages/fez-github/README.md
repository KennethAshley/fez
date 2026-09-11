# @fezchat/github

GitHub activity in your Fez channels. Attach a repository to an existing channel or create a new one; each issue or pull request gets a thread. Several repositories can share a channel. A read-only GitHub App polls on the owner's machine and publishes updates to the relay.

## Choose a destination

Open **Settings → Extensions → fez-github**. Connect GitHub, choose a channel beside a repository, and click **watch**. To move a watch, choose another channel and click **Save channel**. Only the workspace owner can create channels. Triage remains a separate opt-in because it spends agent turns.

Destinations are saved as channel IDs in encrypted config (`channelIds`), so renaming a channel does not break a watch. Old watches keep their channels and thread history: migration uses exact GitHub repository metadata, never a matching channel name. Missing or ambiguous destinations require a choice in settings. Archived channels are unavailable. Moving a watch leaves old messages in place; future changes start threads in the chosen channel.

GitHub does not claim a sidebar section. Its channels appear in Fez's ordinary channel list, and its settings live with other extensions.

The headless command is `/github watch owner/repo <channel-id>`. Create a channel in Fez first, or use the settings picker. `/github forget owner/repo` stops updates without deleting messages; `/github triage owner/repo` toggles triage.

## The other door

This is the bridge that *watches* a repo you host elsewhere. For agents that WRITE code — pushing as themselves, on a forge the relay owns — see [@fezchat/git](../fez-git/README.md).

## Parts

`headless` (poller + `/github`), `gui` (connect an account). The token lives in the keychain; the webview may store it, never read it.
