# Slack → Fez → the same Slack thread

An explicit mention of your custom Slack app by an approved user becomes a task for one selected Fez agent. The bridge acknowledges the task, posts a generic progress message when that agent replies to the request, and returns its correlated terminal success or error to the original Slack thread. Ordinary messages, bot messages, other users/channels/workspaces, and shared Slack Connect channels do not start work. Follow-up app mentions in the same Slack thread stay in the same Fez thread.

## Set up

1. Create a custom app in your Slack workspace using [app-manifest.json](./app-manifest.json). Name its bot `fez`. This is a custom Socket Mode app; this extension does not ship a centrally hosted OAuth service.
2. In **Basic Information → App-Level Tokens**, generate an `xapp-…` token with **connections:write**. The manifest enables Socket Mode and subscribes to `app_mention` with the bot scopes **app_mentions:read** and **chat:write**. Install the app to your workspace and copy its **Bot User OAuth Token** (`xoxb-…`). Workspace administrator approval may be required by your Slack policy.
3. Invite `@fez` to the one Slack channel you want to use. Copy the workspace ID (`T…`), channel ID (`C…`, or `G…` for a private channel), and allowed users' member IDs (`U…`/`W…`). An empty allowed-user list never grants access.
4. In Fez's **Slack** extension settings, enter those IDs, select an existing Fez channel and your attested agent, and paste the two tokens. Enable the bridge and save. Tokens are written to the macOS Keychain service `fez-skill-env`, accounts `fez-slack.bot_token` and `fez-slack.app_token`; the settings panel has no read-token operation. Settings are self-encrypted on the relay.
5. Keep the local Fez sentinel running. Only its scheduled task opens the socket; opening the TUI or settings panel does not. It checks settings every minute and subscribes to changes. The selected agent must be owner-attested, a workspace member, and unbanned. The owner must also remain a member with permission to submit work.
6. From an allowed Slack account, mention the app in the configured channel, for example `@fez review the proposed API`. For a follow-up, mention it again inside the original Slack thread. The agent must use Fez's `complete_work` result operation for the final answer to return.

Disable and save to stop the connection and cancel pending exports. Every settings save creates a new revision and cancels old pending work, including changes made while the sentinel was offline; it cannot undo tasks already published to Fez or posts Slack has already accepted. Re-enable after choosing new settings to accept new mentions. Revoke the Slack tokens in Slack to disconnect the app permanently.

## Delivery and boundaries

Incoming envelopes are acknowledged after a durable local journal write, before agent work. Replayed Slack event IDs do not create a second Fez task. Signed Fez requests are persisted before publication, so a retry after an ambiguous publish uses the same Nostr event ID. State and Slack/Fez thread correlations survive restart, scoped to the owner's pubkey, relay, Slack workspace, and Slack channel. Already accepted pending tasks can resume; unseen events older than five minutes or from before the current bridge startup are ignored. No Slack history is fetched or imported. API rate limits honor Slack’s Retry-After cooldown without blocking the sentinel.

The agent's `fez_complete_work.summary` contains the actual answer shown in Slack, not a narration of its activity. Successful replies show that answer directly; errors are prefixed with `Failed:`. Terminal replies include up to eight validated HTTPS artifact URLs, with a note to open Fez for any additional artifacts. Only signature-verified replies from the assigned agent with matching channel, thread, request, recipient and terminal status are exported as results. Progress is a fixed status sentence, not arbitrary conversation text. Imported text has Fez mention syntax neutralized to prevent extra owner-signed summons. Result text uses Slack plain-text mode and disables link/media unfurls.

A local journal cannot make Slack's HTTP acceptance and a filesystem write atomic. Posts use a stable `client_msg_id`; after a connection failure, a Slack reply may be repeated if Slack does not deduplicate the retry. This never creates another Fez task. Run one sentinel for a given binding; state is local to that machine. The journal retains event IDs and correlations indefinitely; remove the extension's local data only when deliberately resetting this history.

This first version binds one Slack workspace/channel to one Fez channel/agent and reads credentials from the macOS keychain. It does not implement Slack OAuth distribution, DMs, history search, arbitrary channel mirroring, or automatic agent selection.

## Development

```sh
npm run build --prefix packages/fez-slack
npm run check --prefix packages/fez-slack
npm exec --prefix packages/fez-evals -- vitest --run --root packages/fez-evals tests/slack-bridge.test.ts tests/slack-gui.test.ts
```

Tests use mocked Slack transport and local signed Nostr fixtures; they do not connect accounts or send live Slack messages. The Node bundle includes the existing `ws` dependency and the GUI shares the host's React in the isolated settings runtime.

Protocol references: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [app mentions](https://docs.slack.dev/reference/events/app_mention/), [posting in a thread](https://docs.slack.dev/reference/methods/chat.postMessage/).
