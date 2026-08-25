# Running a public fez relay

A relay is one Node process and one SQLite file. Everything here exists
to make that process start on boot, survive a crash, speak `wss://`, and
have a copy of its data somewhere else.

Live: **`wss://relay.fez.chat`** (also `wss://67-205-188-204.sslip.io`) (DigitalOcean, 1 GB droplet).

## Why sslip.io

`wss://` needs a real certificate, and a certificate needs a hostname.
`67-205-188-204.sslip.io` resolves to `67.205.188.204` with no DNS to
configure and no domain to buy, and Let's Encrypt issues for it happily.
Moving to `relay.fez.chat` later is one line in the Caddyfile plus an A
record — nothing else in this directory changes.

## First time

```bash
ssh root@<ip> 'HOSTNAME_FOR_TLS=<host> bash -s' < deploy/provision.sh
deploy/deploy.sh root@<ip>
```

`provision.sh` does system setup and is idempotent — re-run it freely.
`deploy.sh` ships the relay and nothing else, so a routine deploy can
never break the machine.

## Deploying a new build

```bash
deploy/deploy.sh root@67.205.188.204
```

Builds the relay to a **single 345 KB file** with esbuild, smoke-tests
that it starts, ships it, and restarts the unit — failing loudly with
the journal if it doesn't come back. No repo clone, no `npm install`, no
registry, and nothing on the box that can drift from what was built
here. The previous build stays as `fez-relay.mjs.prev`:

```bash
ssh root@<ip> 'cd /opt/fez && mv fez-relay.mjs.prev fez-relay.mjs && systemctl restart fez-relay'
```

## Policy

Set in `fez-relay.service`, deliberately explicit:

| policy | what it does |
| --- | --- |
| `rate-limit=600` | caps events per connection per minute |
| `membership` | h-tagged content reaches authed members only |
| `kind-whitelist=…` | only fez's 45 kinds are accepted |

**`kind-whitelist` must carry its list.** The built-in parses an empty
argument as `[0]`, which rejects every fez event and looks exactly like
a relay that doesn't work. When you add a kind to `src/kinds.ts`, add it
here too.

**`membership` fails closed on reads.** Messages, docs and reactions are
delivered only over a NIP-42-authenticated connection, to members of
that channel. This is the gate that does not exist on a generic nostr
relay, and the reason pointing fez at a public relay quietly voids its
security model.

The cost is a sharp edge worth remembering: an unauthenticated client
connects fine, subscribes fine, and receives **nothing**. It looks
exactly like an empty relay. Any fez process that reads channel content
must pass an `authSigner` — fez-workflows didn't, and would have run
healthy and idle forever. If something on a gated relay "can't see
anything", check for a signer before you check for data.

Community and channel metadata stay public, so a stranger can still
discover a community and ask for an invite.

## Adding a relay does not copy history

Fan-out applies to events published *after* a relay joins your set.
Nothing back-fills. A new relay therefore knows nothing about the
community it just joined, and the union only looks complete while the
original relay is alive — a single point of failure wearing a second
relay as a disguise.

```bash
node deploy/mirror.mjs ws://localhost:7777 wss://relay.fez.chat
```

Safe to re-run: events are content-addressed and the destination dedupes
by id.

## Operating it

```bash
systemctl status fez-relay        # is it up
journalctl -u fez-relay -f        # what it's doing
systemctl status caddy            # TLS
ls -la /var/lib/fez/backups       # nightly, 14 days retained
/usr/local/bin/fez-backup         # back up right now
```

**Memory is the constraint, not disk.** The relay holds its query index
in memory and rehydrates at boot, so RAM grows with total history while
disk stays trivial (~700 bytes/event). The unit sets `MemoryMax=650M` so
an unbounded relay is restarted rather than taking `sshd` down with it.
Watch the DO memory alert; when it starts firing regularly, that's the
signal to resize, not a thing to tune away.

## What this deliberately doesn't do

- **No Docker.** One process and one file: systemd supervises it for
  free, whereas `dockerd` would cost ~100 MB of a 961 MB box and make
  the SQLite file a volume mount you must not get wrong. `Dockerfile`
  here is for *other* operators who want one-command relays, not for
  this droplet.
- **No off-box backups.** Nightly dumps live on the same disk as the
  thing they protect, which covers "I broke the data" and not "the
  droplet is gone". DO's snapshots are the floor; a sync to Spaces is
  the honest answer when this relay holds anything you can't lose.
