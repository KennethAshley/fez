# @fez/bittensor

Fez extension for Bittensor — subnet discovery and mining orchestration via taostats.io.

## What It Does

1. **Discovers subnets** — queries taostats.io for dev activity across all Bittensor subnets
2. **Inspects repos** — clones the subnet's GitHub repo and finds miner entry points
3. **Builds Docker images** — generates a Dockerfile tailored to the repo and builds it
4. **Runs miners** — starts a Docker container with your wallet credentials
5. **Helps with registration** — generates `btcli` commands for subnet registration and staking

## Prerequisites

- Node.js 20+
- Docker (for building and running miners)
- `btcli` (for wallet registration: `pip install bittensor`)
- A taostats.io API key
- A Bittensor wallet with TAO for registration

## Environment Variables

```bash
export FEZ_RELAY="wss://relay.damus.io"           # or your local relay
export FEZ_PRIVATE_KEY="your-nostr-private-key"     # agent identity
export TAOSTATS_API_KEY="tao-xxx:yyy"               # taostats.io API key
export BITTENSOR_WALLET_NAME="my-wallet"            # default wallet name
export BITTENSOR_WALLET_HOTKEY="my-hotkey"          # default hotkey name
```

## Running

```bash
# Build the protocol SDK first (from repo root)
npm run build

# Build this package
cd packages/bittensor-taostats
npm install
npm run build

# Run the agent
npx tsx src/agent.ts
# or after build:
node dist/agent.js
```

## Task Types

### `bittensor.list_subnets`

List all Bittensor subnets with their repo URLs.

```json
{
  "task_type": "bittensor.list_subnets"
}
```

### `bittensor.subnet_info`

Get detailed dev activity for a specific subnet.

```json
{
  "task_type": "bittensor.subnet_info",
  "params": { "netuid": 1 }
}
```

### `bittensor.inspect_miner`

Clone a subnet repo and inspect it for miner entry points.

```json
{
  "task_type": "bittensor.inspect_miner",
  "params": { "netuid": 1 }
}
```

Returns the detected miner script, all candidates, and extracted README instructions.

### `bittensor.start_miner`

Build a Docker image and start a miner container.

```json
{
  "task_type": "bittensor.start_miner",
  "params": {
    "netuid": 1,
    "wallet_name": "my-wallet",
    "wallet_hotkey": "my-hotkey",
    "use_gpu": false,
    "axon_port": 8091
  }
}
```

### `bittensor.stop_miner`

Stop a running miner container.

```json
{
  "task_type": "bittensor.stop_miner",
  "params": { "container_name": "fez-miner-1-1234567890" }
}
```

### `bittensor.register_wallet`

Get `btcli` registration commands for a subnet.

```json
{
  "task_type": "bittensor.register_wallet",
  "params": {
    "netuid": 1,
    "wallet_name": "my-wallet",
    "wallet_hotkey": "my-hotkey",
    "execute": false
  }
}
```

Set `execute: true` to run the commands (requires `btcli` installed locally).

## Security Notes

- **Arbitrary code execution**: Miner code comes from third-party GitHub repos. Docker provides isolation, but review the repo before running.
- **Wallet security**: `WALLET_NAME` and `WALLET_HOTKEY` are passed as env vars to the container. The actual private keys stay on your host in `~/.bittensor/wallets`.
- **Registration costs**: Registering on a subnet costs TAO (recycled). Review commands before executing.
- **API key**: Never commit your `TAOSTATS_API_KEY` to version control.

## Limitations

- Not all Bittensor subnets follow the same repo structure. The inspector tries common patterns but may miss custom setups.
- Some subnets require GPU, specific CUDA versions, or custom startup flags. The generated Dockerfile is a starting point — you may need to edit it.
- The agent does not monitor miner health or auto-restart crashed containers.
