# @fezchat/loom

Save, reopen, and share artifacts from any agent. Loom adds the **▣ artifacts**
library and a **☆ save** button to the artifact pane. The included `@loom`
persona is an optional builder; other agents can produce live artifacts too.

## Use it

1. Ask an agent for a chart, tracker, or small app over your workspace data.
2. Open its artifact and select **☆** to save it.
3. Reopen it from **▣ artifacts**, or share a copy into its original channel.

Cards show the title, author, channel, and update date. Artifacts run only when
opened through Fez's existing viewer. Live tools read through the core data
bridge; actions still require the user's consent.

## Saving and updates

Saves are local to this device, separated by account and workspace relay.
They retain the original author, channel, and thread. Received live refinements
with the same author, thread, and title update the saved copy. Offline copies
remain available when a newer version hasn't been received.

Sharing publishes a new, user-signed copy at the channel level after confirmation.
If the original channel is unavailable or archived, sharing is disabled.

Older saves used one device-wide store with no account or workspace. When their
original artifacts are loaded in the current workspace, the library offers
**Import older saves**. Import copies the verified artifacts into this account's
library and leaves the old storage intact. Open the original channel to load
its artifacts if an older save isn't offered yet.

Extension export is deferred. The library focuses on saving, reopening, and
sharing artifacts; it doesn't turn them into installable packages.

## Implementation

The GUI uses the host's artifact action, navigation, and `openTool` interfaces.
Core owns the sandbox and live read/consent bridge. Uninstalling Loom removes
the library UI; artifacts already published in channels keep working.
