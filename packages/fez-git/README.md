# @fez/git — git hosting for a fez relay

The relay serves your repositories; your agents work them as themselves.
No forge account, no shared bot identity: **an agent's nostr key is its
git credential**, its commits carry its name, and revoking one agent
revokes exactly one agent.

```
fez install @fez/git            # every part, in one install
# on the relay:
fez relay --extensions --origin https://your-relay
```

## The model

| git            | fez                                             |
|----------------|-------------------------------------------------|
| repository     | a **channel** (owner-signed; its doc is the repo's front page) |
| branch         | a **thread** in that channel                    |
| a line of work | a thread agents are pointed at (`/repo branch`) |
| an agent's work| its own branch, `agent/line` — one thread, one owner |
| merge          | the one serialization point — a command/button, fast-forward only |

Rules the relay *enforces* (not conventions):

- **`main` is protected** — owners and admins only, fast-forward only,
  no deletes. Set per-repo with `/repo protect <repo> <refs|none>`.
- **Every agent works on its own branch** — concurrent agents cannot
  collide at the ref level; conflicts can only appear at merge, where a
  human is standing.
- **Notifications derive from state, never the reverse.** Refs are the
  truth; the push journal records how they got there; threads are
  written from the journal. A lost message never means a lost commit.

## Day one

```
/repo new myproject             # channel opens; repo appears on first push
~/.fez/bin/fez-adopt            # or: put the repo you're STANDING IN on the relay
fez-adopt https://github.com/o/r   # or: clone + adopt an upstream in one step
```

Then put agents on it:

- mention an agent **in the repo's channel** → it works that repo on its
  default lane (`agent/work`)
- `/repo branch myproject feat-x` opens a **line**; mention agents **in
  that thread** → each gets `agent/feat-x`, cut from the line's tip
- every branch becomes a thread; pushes are announced in it; the **lane
  board** (rendered above any ⑂ thread's replies) shows each lane live
  with watch / diff / merge
- `/repo merge myproject reviewer/feat-x` — or the board's merge button
- agents' current branch shows beside their name in chat, zsh-prompt
  style — announced from the actual checkout at spawn, not claimed

Parallelism = more agents, not multiplexed ones: the **twin** button in
the agents pane mints `researcher-2` (same persona text, its own name
and key).

## Parts

One package, five attachment points — `fez install` places them all:

| part        | lands in                     | does |
|-------------|------------------------------|------|
| `relay`     | relay `--extensions` dir     | serves `/git/*` (smart HTTP via `git http-backend`), branch protection, push journal, diff/merge/sync endpoints |
| `headless`  | `~/.fez/extensions`          | `/repo` in TUI + sentinel; branch→thread task (needs `background`) |
| `workspace` | `~/.fez/workspace-providers` | a `repo:` persona gets a checkout: own clone, own branch, sparse cone, auth baked into the clone's config |
| `gui`       | `~/.fez/gui-extensions`      | Repos panel, `/repo` in the composer, the lane board thread view |
| `bin`       | `~/.fez/bin`                 | `git-credential-fez`, `fez-adopt` |

The relay part composes: a bare relay serves no git; access is an
injected `GitAccess` (fez's is the workspace roster — 47102 membership,
47102 roles for protection, 30047 bans), auth an injected authenticator
(fez's is NIP-98: a signed event **is** the git password, scoped to one
repo for 60 seconds).

## HTTP surface (all NIP-98-gated like clone)

| endpoint | verb | what |
|---|---|---|
| `/git/<repo>.git/…` | git | smart HTTP — plain `git clone`/`push` |
| `…/fez-push-journal` | GET | who moved which ref where (TSV; transport truth) |
| `…/fez-diff?from&to` | GET | review diff, three-dot ("what did this branch do") |
| `…/fez-merge?branch[&into]` | POST | fast-forward merge, atomic CAS; protection enforced; journaled |
| `…/fez-sync?ref` | POST | publish one branch to the recorded upstream (owner/admin; needs `FEZ_GITHUB_TOKEN` in the relay env for https upstreams; never force) |

Merge semantics live **only** here — the `/repo merge` command and the
lane-board button are both signed knocks on the same door.

## Upstreams (GitHub)

One-way by design: fez is the working truth, the upstream a shop
window. `fez-adopt` records `upstream` on the channel; `fez-sync`
publishes a branch there with authors intact (git separates author from
pusher). Pulling upstream changes in is a human act:
`git pull origin main && git push fez main`.

## Custody

- Agent keys: keychain (`agent:<name>`), minted once, stable — which is
  why `/invite @persona` works before first spawn.
- The credential helper is written into each checkout's local config
  (with an empty first entry to neutralize macOS's osxkeychain helper);
  the agent process carries `FEZ_SECRET_KEY` so its pushes are its own.
- The relay holds no signing key — it cannot announce, only record.
  The half that posts threads runs beside the owner's key (sentinel).
