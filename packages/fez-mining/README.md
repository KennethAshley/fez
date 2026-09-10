# @fezchat/mining

Manage Bittensor miners in Fez: a subnet catalog, a fleet with history, management
panes, and mining tools for your agents. Install a subnet adapter to enable its
supported workflow; a subnet appearing in the catalog does not mean it is supported.

## Install

Requires **Fez desktop 0.4.33 or newer** on macOS. In **Settings → Extensions**,
install these packages in order (use their exact names in the install field):

1. `@fezchat/wallet` — version 0.1.14 or newer.
2. `@fezchat/mining` — version 0.1.1 or newer.
3. `@fezchat/numinous` — version 0.1.1 or newer.

Older desktop versions and the npm Protocol 0.2.1 CLI cannot install miner
adapters. Update the desktop first. Node 20+ is required to run extension CLIs.

Restart Fez after installing. Open **Mining → Numinous → Manage**, choose your
persona, and refresh status. This release supports Numinous **testnet 155 / SIGNAL**.
Set Wallet to **test** before using it. Registration and code upload are separate,
explicit actions. Existing submissions can be adopted without uploading again.

Numinous validators host submitted code. Fez keeps the version history and
reported activation status; your Mac does not need to run a persistent miner
process for an accepted upload. Docker is needed only for the local code check.
See [the Numinous package](https://www.npmjs.com/package/@fezchat/numinous) for
that check's setup and limits.

## Channel workspace

Desktop builds with channel workspace support first ask you to link Mining to
an existing channel or create one. Linking requires the workspace owner; it
preserves the channel's history. Mining and that channel open the same Activity
conversation, with **Miners** and **Subnets** tabs beside it. Renaming the channel
keeps the connection. Archiving it returns Mining to setup; removing the
extension keeps the channel and its messages.

Use **New miner → Subnets → Launch** to choose a dedicated specialist or an
existing agent and enable its mining tools before setup. **Miners** retains
stopped operations: **History** opens the persona-authored thread, and **Manage**
opens the same controls available from the thread. Stopping the last miner keeps
the agent's mining capability attached so you can discuss history or start again.
Older desktop builds retain the previous Mining page.

## Agent tools

Add `mining=npm:@fezchat/mining` to a persona's `mcpServers`, or attach Mining in
its tool picker. The tools bind to that persona; they do not accept another
persona's identity as an argument. Ask the agent for mining status, configuration,
or Numinous submission history in a channel or DM.

`mining_submission` provides `status`, `test`, `submit`, and `register`. A submit
requires the SHA256 returned by a successful test of the same file. Registration
may burn testnet TAO; uploads are never automatic. Secret configuration stays in
the GUI/keychain and is not exposed by the mining configuration tool.

## CLI

```sh
fez-mine subnets --refresh --json
fez-mine status --json
fez-mine submission status --netuid 155 --persona drift --json
fez-mine submission test --netuid 155 --persona drift --file /path/to/agent.py --json
```

The management pane also works inside a miner's thread. Runner-based adapters
use their own machine requirements and start/stop controls; submission adapters
use version and upload controls. Numinous mainnet mining is not enabled by this
release.

When enabling Mining for an existing agent, the setup shows a restart notice. If the chat agent is running, finish its current turn and restart it from its profile to load newly attached tools. Sleeping agents load them on their next mention. Restarting the chat agent does not restart its miners.
