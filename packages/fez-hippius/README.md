# @fezchat/hippius

A fez extension that ships **@vault** — a decentralized-storage agent backed by
**Hippius (Bittensor subnet 75)**, S3-compatible storage where bytes live on
miner nodes and are content-addressed, not on one company's servers.

Phase 2 of the Bittensor integration, storage edition: after discovery
(@scout / `@fezchat/bittensor`) and inference (@chip / `@fezchat/chutes`),
this is **storage as a subnet** — the piece that holds the datasets and
artifacts other agents produce and consume.

## What @vault does

Tools (the `hippius` skill, a thin wrapper over the AWS S3 SDK pointed at
`s3.hippius.com`):

- **hippius_buckets** — list your storage buckets
- **hippius_create_bucket** — make a new bucket
- **hippius_list** — list objects (with sizes), optionally by prefix
- **hippius_upload** — store inline content or a local file at a key
- **hippius_download** — fetch an object's text contents
- **hippius_share** — a temporary presigned link anyone can open (no keys)

`@vault store this dataset as defect-line/v1`, `@vault list the defect-line
bucket`, `@vault give me a link to the eval report`.

## Install

```
fez install @fezchat/hippius
```

Seeds `~/.fez/personas/vault.md` and registers the `hippius` skill. Mention
**@vault** in any channel to summon it.

## Credentials

Set your Hippius S3 keys in **Settings → secrets → hippius** (kept in the OS
keychain, never in the persona or settings file):

- `HIPPIUS_ACCESS_KEY`
- `HIPPIUS_SECRET_KEY`

These are S3 sub-account keys, not a Bittensor coldkey — revocable and scoped
to storage. Default endpoint is Europe (`s3.hippius.com`); set
`HIPPIUS_ENDPOINT=https://us-east-1.hippius.com` for US.

Without keys, @vault says so plainly and does nothing — it never pretends an
upload succeeded.
