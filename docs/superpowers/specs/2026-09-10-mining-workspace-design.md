# Mining workspace

## Approved experience
Mining remains one entry under Extensions. It opens the same native conversation as its linked channel. Activity, Miners, and Subnets tabs share that channel workspace. Activity uses the existing timeline, composer, agent mentions and threads. A compact fleet summary and New miner action lead to the other tabs. Miners retains stopped operations and history; Subnets retains the complete catalog and existing launch gates. One management pane serves both fleet and miner threads.

Setup explicitly links an existing ordinary channel (suggest #mining), or creates a named channel. No silent takeover or background channel creation. The owner-signed channel metadata records the binding; channel ID, not name, is authoritative. Renaming preserves the connection. Replacing an archived binding retires its marker so restoring that channel cannot steal the new binding. Duplicate channel creation opens the existing channel. Uninstall leaves channel and messages intact.

A new operation can use a dedicated specialist agent or an existing persona. Mining capability is attached before configuration and retained when the last miner stops. Existing agents get a tools-saved step with explicit profile restart instructions; active conversations are never killed automatically. Agents keep their ordinary identity, presence, mentions and DMs. New miner roots and lifecycle updates are authored by the persona; controls never impersonate the user. One persistent thread per channel, persona and subnet holds history.

## Host contract
Extend registerNavView with an optional channel workspace: getChannelId(), tabs, and summary render. Activity is host-owned; custom tabs render extension content. Add generic optional openChannel and openPanel capabilities. Fix openThread navigation at the app boundary. No mining-specific logic enters core or desktop.

## Data and boundaries
Channel metadata marker: miningWorkspace: "true". Only explicitly adopted, unarchived channels qualify. Preserve unrelated metadata and channel visibility. Legacy source=mining channels are offered for adoption. Miner state records the active thread channel/relay alongside its root and retains prior roots per relay/channel for returning workspaces. Background updates resolve the binding and never recreate it by name. Metadata is workspace-scoped by the existing signed channel protocol.

Testnet-only mining gates, secret custody, spend approvals, and submission source review remain unchanged. Tests use generated local identities and a local relay; no real registrations, paid infrastructure, submissions, or user channel messages.

## Visual direction
Use Fez's native channel shell, typography and theme variables. Quiet hairline tab bar, compact fleet counts, 20px content padding, 16px pane padding, visible keyboard focus. Preserve the subnet table, logos and smaller component stack labels. No new CSS framework or dependency.

## Verification
Check binding/reuse/rename/archive and duplicate-name behavior, actual native chat navigation from both sidebar entries, fleet history and shared pane, persona skill retention, and persona-authored thread reuse. Run package checks, complete eval gate, desktop browser tests and screenshot inspection before completion.
