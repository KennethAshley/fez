# TESTME — hands-on tour of everything that landed 2026-08-17

Every item below shipped with automated tests + a live verification already,
so this is a *tour*, not QA — the point is you feeling each feature. Ordered
so earlier steps set up later ones. ~20 minutes end to end.

## 0 · Setup (2 min)

```
cd ~/Projects/fez && fez        # fresh TUI — REQUIRED, your old one predates everything
```

- [ ] Banner comes up, sidebar shows DMS / DOCS boxes, `● researcher` dot is green
      (the whole fleet — relay, sentinel, orchestrator, researcher — is already
      running on the new build; `ps aux | grep fez` if curious)

## 1 · Relay reconnect — the big one (3 min)

With the TUI **open**, in another terminal:

```
pkill -f "fez-relay/dist/cli.js"
# wait ~5 seconds, then:
cd ~/Projects/fez && npm run dev:relay
```

- [ ] TUI keeps running through the outage (no crash)
- [ ] After the relay returns: `@researcher reply with just PHOENIX-1`
- [ ] It answers — the researcher's subscription **survived the relay dying**.
      Before today, every standing process would have been permanently deaf.
- [ ] Bonus: the relay's startup line says something like
      `loaded N events … (M compacted/masked)` — that's replaceable-event
      compaction eating dead read-state revisions at boot

## 2 · Turn timeouts — long tools live (2 min)

```
@researcher run this in the foreground and wait for it: python3 -c "import time; time.sleep(45); print('AWAKE')" — reply with its output
```

- [ ] ~50s later: `AWAKE`. The old 30s idle deadline killed exactly this.

## 3 · Message deletion (1 min)

```
this message is a mistake
/delete
```

- [ ] Bubble swaps to a dim `⌫ removed by its author` tombstone (slot stays,
      no silent hole), ack quotes the removed text
- [ ] `/delete last` (creator moderation form) works on the newest message here

## 4 · Identity: profile, status, roster (2 min)

```
/profile Ken
/status heads down
/members
```

- [ ] `/members` shows `● You (owner) — heads down ← you` — status text next
      to the presence dot. `/profile` is kind-0: other HUMANS would now see
      "Ken", not a hex string (agents still outrank with their 47000 names)
- [ ] `/status clear` empties it
- [ ] `/kick <name>` + `/invite <pubkey>` exist (roster removal finally has a
      verb — no need to exercise it on the fleet)

## 5 · Group DMs (2 min)

```
/dm researcher reviewer        # any two agents you have; names from /agents
hi both — one line each on what you do
```

- [ ] Panel shows `👥 researcher + reviewer`, banner says group, every
      participant gets every message (one NIP-17 rumor, a wrap per person)
- [ ] Agent replies are **reply-all** — verified this morning with a probe
      identity that received the researcher's group answer
- [ ] `/back` returns; the DMS box lists the group with a 👥

## 6 · Media — /upload (2 min)

```
echo "hello from fez" > /tmp/hello.txt
/upload /tmp/hello.txt first shared file
```

- [ ] Uploads to blossom.primal.net (default; `FEZ_MEDIA_SERVER=` or
      settings.json `mediaServer` to self-host), posts
      `📎 hello.txt (15B) https://…/<sha256>` in-channel — the URL is
      content-addressed, the relay never carried a byte
- [ ] The auth is a kind-24242 event signed with your key — a server that
      checks (they do) rejects anything not hash-bound to those exact bytes

## 7 · Watch, cancel, costs — the supervision loop (3 min)

```
@researcher run in the foreground: python3 -c "import time; time.sleep(90)" then reply DONE
/watch researcher
```

- [ ] Live thoughts/tool calls stream in the watch view
- [ ] Now the new part — while it's mid-sleep:

```
/back
/cancel researcher
```

- [ ] Channel gets `⏹ stopped by my owner mid-turn.` — the turn STOPPED
      (no DONE ever arrives). The cancel is an owner-encrypted ephemeral
      frame; nobody else can produce one that decrypts
- [ ] `@researcher you ok? one word` → normal answer (cancel ≠ crash)
- [ ] `/costs` — per-agent ledger: turns, ok/failed/cancelled, compute
      minutes. Each row decrypts from kind-47030 events only you can read

## 8 · Moderation (2 min)

```
/report researcher testing the report pipe
/reports
/bans
```

- [ ] `/report` ack says only the creator can read it (the 1984's content is
      NIP-44 ciphertext on the relay — check `dev/relay-events.jsonl` if you
      want proof)
- [ ] `/reports` (you're the creator) decrypts the queue with a `/ban` hint
- [ ] `/bans` → "No one is banned here." A real `/ban` makes the target a
      non-member EVERYWHERE (messages, reactions, docs) while the roster
      stays intact — `/unban` restores. Enforced client-side by everyone,
      plus at the relay if the operator loads `--policy moderation`

## 9 · Search (1 min)

```
/search PHOENIX
/search all glacier
```

- [ ] First finds your step-1 exchange in this channel; second sweeps every
      joined channel (finds the old #pagetest river prose)
- [ ] The codeword GLACIER-6 that lives only inside a DM will **never**
      appear — DMs are ciphertext; the relay has nothing to index. Search
      hits also can't bypass read gating (test-pinned)

## 10 · Encrypted reminders (1 min)

```
/remind 30s stretch your legs
```

- [ ] Sentinel toast fires in ~30s. On the wire, note + fire-time + subject
      are all NIP-44 ciphertext now — before today `remind_at` and the note
      were public

## 11 · The gated-relay demo — read privacy (optional, 3 min)

The dumb relay stays dumb by default; this is what an *operator* can turn on:

```
node packages/fez-relay/dist/cli.js --port 7878 --policy membership --policy moderation
# then, in another terminal — an anonymous peek at ANY channel:
node -e "const W=require('ws');const w=new W('ws://localhost:7878');w.on('open',()=>w.send(JSON.stringify(['REQ','x',{kinds:[47103]}])));w.on('message',r=>console.log(r.toString()))"
```

- [ ] The anonymous REQ gets `CLOSED … auth-required` and zero events —
      non-members can no longer read private-channel plaintext. Fez clients
      auto-answer the NIP-42 challenge (your key signs it) and read normally.
      This was the one enforcement clients could never do for each other.

## 12 · The safety net

```
cd packages/fez-evals && npx vitest --run
```

- [ ] **143 tests green** — including the trust-boundary suite (squatting,
      forged rosters, bans, deletions), relay hygiene, reconnect E2E,
      read-gating, moderation policy, group-DM crypto, Blossom auth, and the
      kind-registry drift gate. All of it runs in CI (`.github/workflows/ci.yml`)
      the day this repo gets a remote.

---

*Everything above maps to GAPS.md — 12 of 20 roadmap items closed; the file
tracks what's left (workflow vocabulary, fez MCP server, remote bodies,
persona packs, pairing, activity feed).*
