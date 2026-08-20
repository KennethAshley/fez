# Connecting fez to GitHub

fez talks to GitHub through a **GitHub App** you register once and install
on the repos you choose. Two properties matter and both come from that
choice rather than from anything fez does:

- **Read-only.** The bridge never writes. The permissions below are the
  complete list it can ever use.
- **Per-repo.** You pick which repositories the app can see, on GitHub,
  before fez asks for anything. A repo you don't install it on is not
  something fez can decline to read — it's something fez cannot see.

That is a stronger guarantee than a config setting, because it is
enforced by GitHub rather than by us.

## 1. Register the app

<https://github.com/settings/apps/new>

| field | value |
|---|---|
| **GitHub App name** | `fez` (or `fez-<yourname>` if taken) |
| **Homepage URL** | `https://fez.chat` |
| **Webhook** | **uncheck Active** — fez polls, it does not receive |

**Repository permissions** — set these three to **Read-only** and leave
everything else at *No access*:

- **Issues** → Read-only
- **Pull requests** → Read-only
- **Checks** → Read-only

*(Metadata: Read-only is added automatically and is mandatory.)*

**Where can this app be installed?** — *Only on this account*.

Create it.

## 2. Enable device flow

On the app's settings page, tick **Enable Device Flow** and save.

This is off by default, and without it step 4 fails with a confusing
error. It is what lets fez authenticate with no client secret — a
desktop app cannot keep a secret, so any flow that needs one is a flow
that lies about being secure.

## 3. Install it on your repos

**Install App** in the left sidebar → your account → **Only select
repositories** → choose them.

You can change this list any time, and revoking a repo takes effect
immediately.

## 4. Connect

Copy the **Client ID** from the app's settings page (it looks like
`Iv23li...`; it is public, not a secret), then:

```
fez github connect --client-id Iv23li…
```

fez prints a code, you enter it at <https://github.com/login/device>,
and that's the last time you touch it. The token lands in your keychain
— never in `settings.json`, never on the relay.

## What fez stores

| where | what |
|---|---|
| macOS keychain | the access token, and a refresh token |
| relay (self-encrypted) | which repos to watch |
| nowhere | your GitHub password; anything with write access |

## Revoking

<https://github.com/settings/installations> → fez → **Uninstall**. The
token stops working immediately. Nothing on fez's side needs to know.
