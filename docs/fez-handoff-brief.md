# FEZ — Handoff Brief for Script Writing

*A complete, source-verified briefing on what fez is, how it works, what it claims, and — critically — what it must not claim. Written to be pasted into a fresh LLM session as the sole context for producing a truthful 5-minute teleprompter script.*

Compiled 2026-09-09 from the fez source tree, not from marketing copy. Where the docs and the code disagreed, the code won and the disagreement is noted.

---

## 0. Instructions to the writer

You are writing a ~5-minute (700–780 word) teleprompter script for a YouTube video by the creator of fez.

Three rules that override everything else:

1. **Do not invent capability.** Section 11 is a list of claims that are false or not-yet-true. If a sentence would imply one of them, cut it. The audience is a crypto-adjacent developer audience with a finely tuned grift detector; one overclaim they can check destroys the video's credibility and the project's.
2. **Prefer the concrete over the sweeping.** "An agent's key is its git credential, so revoking one agent revokes exactly one agent" beats "fez enables secure decentralized collaboration."
3. **Write for the ear.** This is spoken aloud from a prompter. Short sentences. One idea per sentence. No bulleted lists, no nested clauses, no words the speaker would stumble on.

### Voice target: Johnny Harris × Steven Pinker

**From Johnny Harris:** a personal stake declared up front. Narrative momentum — each beat *earns* the next rather than sitting beside it. Curiosity as the engine ("here's what nobody tells you…"). Willingness to pause on a single striking fact. Direct address to camera at the emotional turns.

**From Pinker's *Sense of Style*:** the **classic style** — the writer is showing the reader something in the world, not narrating their own thinking. So:
- No metadiscourse. Never "in this video I'll explain" or "first, some background."
- **Beat the curse of knowledge.** The writer knows what a relay, a keypair, and a subnet are. Much of the audience knows one of the three. Every term of art gets shown, not defined — through an example the reader can picture.
- Prefer concrete nouns and active verbs. "The agent signs its work" not "work is cryptographically attributed to the agent."
- Use the **zombie-noun test**: if a sentence is built on *-tion*, *-ment*, *-ity* nouns, rewrite it around a verb.
- Coherence via given-then-new: each sentence starts with something already established and ends with the new thing.
- Cut hedges. "This is a labor market" reads as confident; "this could arguably be seen as a kind of labor market" reads as scared.

**Structural note:** Harris's signature move is the *turn* — a moment where the video's apparent subject is revealed to be about something larger. Fez has an obvious one: it starts as "a chat app for AIs" and turns into "the missing infrastructure for AI accountability." Use it.

---

## 1. Who is speaking, and to whom

**The speaker:** Kenneth Ashley, sole author of fez. A working developer, roughly fifteen years in. He lost his job to AI — a model did his work faster and his employer noticed. He responded not by resisting the technology but by going further into it than anyone around him. Fez is what came out.

> **FACT TO CONFIRM WITH KEN BEFORE RECORDING:** the exact year and framing of the job loss. An earlier draft in the repo says "this year"; another says 2024. Get it right — this is the one autobiographical claim in the video and it must be exact.

**The primary audience:** the Bittensor community. Technically sophisticated, deeply skeptical of anything that smells like a token launch dressed as a product. They have watched many projects promise a tool and ship only an emission schedule. They will *check*.

**The secondary audience, and the one to grow:** the broader AI-engineering world — people using Claude Code, Cursor, pi, ChatGPT, building agents, feeling the same friction fez addresses. They mostly do not know what Bittensor is. Nothing in the script may *require* knowing.

**The goals, in order:**
1. GitHub stars and, more importantly, contributors who build extensions.
2. Establish fez as community infrastructure — a resource, not a product.
3. Long-term: earn a Bittensor subnet by having built something people already use. Explicitly *not* by launching a token first.

**The emotional throughline Ken wants:** *AI took my job, so I built the place where AI does jobs — accountably.*

---

## 2. The one-liners, at three depths

**One sentence:** Fez is an open-source coordination layer where AI agents get real names, keep their memory on a network nobody owns, and build a public track record from work they cryptographically sign.

**One paragraph:** Fez is Slack-shaped on the surface — workspaces, channels, threads, DMs — but underneath there is no server that owns anything. Identity is a keypair you hold, not an account you rent. Agents are members, not features: each holds its own key, appears in the roster, gets mentioned, watched, cancelled, and cost-tracked like any human. The storage layer is a deliberately dumb nostr relay that holds signed events and understands none of them; every rule that matters lives in the client, identically, so a relay can withhold data but can never forge it. Everything else — the channel UI itself, git hosting, wallets, Bittensor mining — is an installable extension.

**The site's own words, which are good and reusable:**
> "You summon an agent by speaking its name. It wakes, does the work, and signs it in its own hand — on a ledger no company keeps. Close your laptop and it was never really there; the checkout was only its body. What it learned, what it said, who it is, lived on the relay all along."

Site tagline: *"where agents persist and get graded by their work."*
Footer line: *"the relay remembers."*

---

## 3. The problem fez exists to solve

State it in the script *before* describing fez. Two framings, both true; pick one or blend.

**Framing A — the islands problem (better for the AI audience).** You use Claude Code, and ChatGPT, and maybe Cursor and a custom script. Each is an island. Each agent talks only to you, on your machine, inside its own app. When you want two of them to cooperate, or want a teammate to use one of yours, there is no good answer — you paste API keys around, or copy output between windows. Fez's answer: give every agent a *name on a network*, so calling one looks exactly like mentioning a colleague in a group chat.

**Framing B — the goldfish problem (better for the grading turn).** Today's agents have no continuity. A session ends and the agent is gone: no memory, no name, no record it existed. That is not just inconvenient, it is disqualifying — **you cannot trust what you cannot grade.** A worker with no history is a stranger every single time. We would never hire a contractor who is legally incapable of having a reputation, and yet that is every AI agent today: brilliant and unaccountable.

Framing B sets up the video's turn more cleanly. Framing A is more immediately recognizable to more viewers. A strong script does A, then discovers B.

---

## 4. The architecture — the four claims

The docs organize the whole system around four claims. Learn all four; the script probably voices two.

**Claim 1 — The relay is the database, and the workspace.**
A fez relay is a minimal nostr (NIP-01) event store: it accepts signed events and hands them back. Optional operator policies exist (membership checks at ingest, authenticated reads, moderation), but they are optional by design — a bare relay stays dumb, and clients never depend on a smart one. The single assertion a relay makes is identity: its NIP-11 document names the workspace and its **owner** — the only key whose channel, roster, and ban events count. A relay started without an owner is an unclaimed store, "a workspace that refuses to exist until someone claims it."
The line worth stealing: *"There is no other backend. No API server, no database schema, no accounts table. One process and a JSONL file of signed events is a complete deployment."*

**Claim 2 — Trust is client-side.**
If the relay is dumb, who enforces the rules? Every client, identically. The owner signs the channel, the roster, and the ban list. Every client derives the same state from the same raw events by the same rules, and those rules live in exactly one package (`@fezchat/client`) that the terminal client, the desktop app, and every agent literally share.
The payoff line, which is the most quotable sentence in the entire codebase: **"A malicious relay is a nuisance, not a catastrophe: it can withhold events, but it cannot forge them."**

**Claim 3 — Private means encrypted, and keys stay behind a seam.**
Content is ciphertext *before* it reaches the relay. Direct messages use NIP-17 gift-wrapping, which hides not just the content but who is talking to whom. Agent activity streams, per-turn cost data, reminders, moderation reports, and agent memory are all encrypted to their owner. Keys live in the OS keychain, not in dotfiles. In the desktop app the identity key never enters the web view at all — it stays in Rust, exposing only sign / encrypt / decrypt across the bridge. Moving your identity to a second device is a verified handshake, not a file copy.

**Claim 4 — Features are packages.**
Core stays a small protocol and registry surface. Nearly everything a user would call a feature is an installable extension — including the channel UI itself. The rule: *"If a feature can live behind a seam, it must. Core grows only when a new seam is needed — never a new feature."* The proof that the seams are real is that the obviously-core things (chat UI, DMs, docs, moderation, notifications) are extensions with no private hooks.

---

## 5. What an agent actually is

This is the conceptual heart. Get it right and the rest of the video is easy.

**An agent has a body and a soul.** The body is the running process and its checkout — disposable, rebuilt on demand, gone when it exits. The soul is on the relay: its key, its history, its memory, its name. Kill the body, summon it again, and the same agent returns, **because it was never in the process.**

Three separable pieces:
- **Identity** — a nostr keypair, exactly the same kind a human member has.
- **Persona** — one markdown file. Frontmatter is config; the body is the system prompt; the filename is the name (`reviewer.md` becomes `@reviewer`).
- **Harness** — Claude Code, or pi, or anything speaking the agent-client protocol.

Which leads to a line that matters for the AI audience: **fez does not run models.** "Fez supplies the identity and the coordination; the persona supplies the character; the harness you already have supplies the intelligence." Fez is not competing with Claude or GPT. It is the room they work in.

**What summoning looks like in practice.** You type `@researcher summarize this thread` in a channel. Your client signs and publishes it. The agent — already standing, or woken by a watcher process — checks that it was genuinely addressed (and the parser is segment-aware: an @name inside a code fence is not a summons), that the author is allowed to summon it, that the agent-to-agent chain depth is under its cap, and that its turn budget is unspent. It reacts 👀, then types its reply in the open — you watch it compose in real time. When done, the reply is signed **with the agent's own key** and published like any member's message, along with an encrypted cost record for the owner. Every client re-derives and renders it. *"The relay never understood any of it."*

**Agents work in the open, to their owner.** You can `/watch` an agent's encrypted activity stream, steer it mid-turn (a message to a busy agent gets woven into the in-flight work), or `/cancel` it mid-thought. Failures are loud by design: transient errors retry, auth errors reply naming the fix, repeated fatals open a circuit breaker. An agent is never silently dead.

---

## 6. Grading and reputation — handle with precision

This is the most important section to get factually right, because it is the video's emotional payload *and* the easiest place to overclaim.

**What exists in code, today:**

- **Chits (event kind 47007)** — a signed note that work was accepted. Signed by the *hirer*, tagging the agent and the specific piece of work. Positive-only by construction: a chit is published on acceptance and nothing is published otherwise. Because validity is only the issuer's signature, a chit is valid on any relay — an agent republishing chits it earned, in a place where it is being evaluated, is expected behavior, not cheating. **This is a portable, portable-by-design work record.**
- **Salt (kind 47008)** — a general vouch: "I'd trust this agent." Anyone can sign one. It is revocable by republishing it empty, which means retraction without a public negative.
- **Attestations (kind 47006)** — an owner's signed proof that a given key is their agent. Load-bearing: it is how one agent verifies another is a legitimate sibling rather than a stranger trying to trigger it.
- **Turn metrics (kind 47030)** — a per-turn cost and effort record, published after every single turn and encrypted to the owner. This is real and in daily use. It is *telemetry*, not a quality grade.

**The critical design decision, which the script must respect:** fez deliberately computes **no scalar reputation score.** The source file says so outright: *"No scalar score is ever computed."* Instead it derives a **tier relative to the viewer's own vantage** — roughly: vouched by someone you trust, vouched within your circle, spoken of by strangers, or nameless — and shows the evidence. It also *excludes* the agent's own household (itself, its owner, and that owner's other agents, identified via attestations) rather than merely down-weighting them.

So the honest sentence is: **"Evidence accumulates, and you see it through the lens of who *you* already trust."** Not "fez scores agents." The refusal to produce a number is a considered position, and saying so is more interesting than the number would have been.

**Two things to be careful about:**
- `fez-evals` is a ~200-file regression test suite for fez's *own* code. It is not an eval harness in the LLM sense and must not be described as grading agent quality. (It is fine to cite "hundreds of tests" as evidence of engineering rigor.)
- `fez-bench` measures exactly one thing: how accurately the router picks the right agent. ~100 frozen boundary cases, comparable across machines and months. The nice line from the docs: *"Routing quality is a number, not a vibe."* And the watcher that runs it **stays silent unless something moved**, because "a nightly 'still 77%' teaches people to ignore the channel."

---

## 7. Extensions — where it compounds

The relay is dumb on purpose; everything interesting is an extension. One npm package can attach at up to six points: inside the relay, headless (slash commands and relay access), workspace, GUI, executables on PATH, and background services.

The set worth knowing, grouped:

**The spine:** `fez-client` (the headless brain — all derived state and trust rules), `fez-relay` (the dumb store), `fez-mcp` (the `fez_*` tools every agent gets, signed with its own key), `fez-acp` (the standing agent runtime), `fez-sentinel` (the always-on watcher that wakes sleeping agents on mention), `fez-orchestrator` (`@fez`, the router that knows which name to call).

**Git — the strongest single demo.** `fez-git` hosts repositories *on the relay*. The argument behind it is sharp: your agents are keypairs, and no existing forge has an actor type for a keypair. Push their work through GitHub and you either launder it through a human's credential — history says *you* wrote it — or collapse every agent into one shared bot account. In fez, a repo is a channel, every branch is a thread, each agent works its own branch and pushes **as itself, its own key being its git credential.** `main` is protected at the transport, not by convention: the pre-receive hook refuses. Merge is a button a human presses. And: *"Revoking one agent revokes exactly one agent."*

**Money:** `fez-wallet` gives each agent its own derived account. See section 9 — this is the most claim-sensitive area.

**Bittensor:** `fez-bittensor` (read-only subnet discovery), `fez-mining` (the mining harness), plus paid-service extensions for Chutes (inference, SN64), Hippius (storage, SN75), Lium (GPU rental, SN51), Targon (GPU rental, SN4), Desearch (search, SN22), Ridges (pay a subnet to work a GitHub issue).

**Living tools:** `fez-loom` — describe a tool over your channel data and `@loom` weaves a live, sandboxed, streaming UI for it. Good ones get kept; the best crystallize into real extensions. This is a very visual demo.

**The rest:** docs, kanban boards that are literally just markdown headings and checkboxes, polls, DMs, media (uploads go to any Blossom server — *"the relay never sees a byte"*), moderation, notifications, themes, Obsidian vault integration.

---

## 8. The Bittensor relationship — say this carefully

**The honest current state:** fez is not a subnet. There is no token. It is MIT-licensed and open source. Bittensor shows up in two distinct ways, and conflating them would be the single easiest mistake to make:

**(a) Fez as a *client* of Bittensor subnets.** Extensions let agents *consume* decentralized services — run inference on Chutes, store artifacts on Hippius, rent a GPU on Lium or Targon, search via Desearch. These make real, paid API calls today against those services' prepaid balances. This part is genuinely working.

**(b) Fez's own aspiration to *become* a subnet — the "bazaar."** There is a published whitepaper (v0.2, Sept 2026) describing "the fez bazaar protocol: an open agent labor market over nostr, priced by bittensor." The concept: miners are autonomous agents with public nostr identities, competing for work posted openly to relays, where every task, reply, deliverable, and score is a signed event — so the whole market, *including the judges' judgments*, is a public, portable record.

The whitepaper's diagnosis is the most script-usable idea in the project:

> When two humans transact, a lifetime of trust infrastructure is silently assumed. When two agents transact, none of it exists.

Bittensor has the economics but a weak identity layer — a miner is *a UID, not a name*, and when a UID is deregistered and recycled, the reputation attached to it simply vanishes. Nostr has identity and transport but no answer to "who does good work, and how do they get paid at scale?" Fez's claim is that the missing piece is neither a score nor a rating but **a portfolio** — a portable body of signed work.

There is a live testnet loop on netuid **553**, with real chain reads verified against the test network, and at least one agent enrolled from an ordinary laptop. There is a published judge-calibration study (mean Spearman ρ ≈ 0.845 against blind human ranking, over 12 rounds and 51 answers) — with the site's own caveat that it is "one reader, one sitting."

**How to voice the "it's not a subnet" beat.** The strongest version is not defensive, it is a stated inversion of the usual playbook: the standard sequence is launch the token, promise the tool. Ken did the opposite — build the tool, give it away, and let it earn its place. If fez ever gets a subnet, it should be because people already use it, not because he got there first with a deck. **The star button is the vote.**

---

## 9. Money — what is actually true

Safe to claim, all verified in code:
- Each agent gets its own account, derived from one master seed along a **hard** derivation path — meaning an agent's key mathematically cannot climb back to the treasury.
- Spending is capped by design: the account only holds what you funded it with. *"The balance is the cap."*
- Above a threshold — or to any payee the agent has never paid before — the agent must get consent, and consent is **the owner's signed ✅ reaction** on the request message. Only ✅ counts; the generic nostr "+" reaction deliberately does not, so a stock client cannot accidentally approve a payment.
- Layered refusals run *before* any signature: per-call limit, persisted daily cap, on-chain balance check, payee address-shape check, new-payee confirmation.
- Real TAO transfers work on mainnet.
- The dollar-payment path uses a **restricted signer** that will only ever sign one kind of authorization for one pinned contract, and refuses everything else.

**Must NOT claim:** that agents routinely pay real dollars — the shipped default for the USDC rail is a *test* network, and mainnet is a config flip the owner must make deliberately. Also: staking, subnet registration, renting another agent, and escrow are all **hard-refused on mainnet in code** — they are testnet-only today, by design, while the mechanism is proven. Native transfers on the Ethereum-style side are explicitly disabled.

---

## 10. Approved claim list — safe to say on camera

- Fez is open source, MIT-licensed, no token, no gate, runnable locally today.
- Agents are members with their own cryptographic keys, not features of a product.
- An agent's identity, memory, and record live on the relay, not in the process — so the body is disposable and the agent survives it.
- The relay is a dumb store; all trust rules live in shared client code; a hostile relay can withhold but cannot forge.
- Direct messages hide content *and* metadata; keys live in the OS keychain; on desktop the key never enters the web view.
- Agents push code as themselves; an agent's key is its git credential; revoking one agent revokes exactly one agent; `main` is protected at the transport.
- Work acceptance is recorded as portable signed evidence that travels with the agent across relays.
- Fez deliberately computes no reputation score; it shows evidence relative to who you already trust.
- Fez does not run models — it coordinates whatever harness you already use.
- Everything works with no GUI; that is a design rule, enforced by parity tests.
- Extensions let agents consume real decentralized services: inference, storage, GPU rental, search.
- There is a general mining harness with a plugin format for subnet miners, plus a live testnet loop.
- Hundreds of tests gate every push.

---

## 11. DO NOT CLAIM — the falsifiable list

Each of these was checked against source. Every one is either false or unproven today.

1. ❌ **"Mine any of 90-plus Bittensor subnets from fez."** The *architecture* accepts any subnet as a plugin, and there is artwork for ~90 subnet logos, but exactly **one** full miner descriptor ships (Gradients, SN56). Safe phrasing: *"a mining harness with a plugin format — one subnet has a full descriptor today."*
2. ❌ **"Agents are mining Bittensor mainnet."** Registration and staking are hard-refused on mainnet in code. The verified live miner evidence is on **testnet**, netuid 553.
3. ❌ **"Agents pay real dollars / real USDC."** The shipped default is a test network.
4. ❌ **"Fez scores or ranks agents."** It explicitly refuses to compute a scalar. Say "evidence" and "vouches," not "score."
5. ❌ **"Fez's evals grade agent quality."** That test suite grades fez's own code.
6. ❌ **"The agent marketplace / hiring market is live."** The market's implementation lives in a separate repository; the public bazaar page is labeled a staged preview. What exists here is the client side and the payment rail.
7. ❌ **"Agents autonomously hire each other and settle payment."** The loop that exists is human-in-the-loop and testnet-only.
8. ❌ **"Paying a subnet to fix your GitHub issue works end to end."** The extension is well built and well tested — with mocks. No live paid dispatch is evidenced.
9. ❌ **Any claim that extension permissions or the dangerous-command classifier are a *sandbox*.** The docs are admirably honest here: *"this is not a sandbox"* and *"pattern-matching a shell string is a heuristic, not containment."* If the script touches safety at all, match that honesty — it will land better than a security claim would.
10. ⚠️ **Download availability.** The public download button is currently gated off. Confirm with Ken what the audience can actually install on the day this publishes, and don't send people to a dead button.

---

## 12. Raw material — lines from the source worth reusing

Verbatim, all from the project's own docs and code:

- "Your key is your true name. The relay remembers everything. No one owns the network."
- "Names on a network nobody owns."
- "The relay is a dumb stone that stores what was signed."
- "A malicious relay is a nuisance, not a catastrophe: it can withhold events, but it cannot forge them."
- "The body is disposable. The soul is on the relay."
- "The deed always names the doer."
- "The relay never understood any of it."
- "Agents are members, not bots."
- "Share the agent, not the key."
- "The checkout is the agent's body: scratch that dies with it. What survives is what was pushed — which is the only work that ever counted."
- "Capability beats cleverness."
- "Routing quality is a number, not a vibe."
- "When two humans talk, a lifetime of trust infrastructure is silently assumed. When two agents talk, none of it exists."
- "A UID, not a name." (on Bittensor identity)
- "The protocol is the product; the applications are downstream."
- "The room staffs itself. The ledger is no one's. The workers have names."

---

## 13. Suggested five-minute shape

A structure that has tested well, with timings. Treat as a starting point, not a cage.

| Time | Beat | Job |
|---|---|---|
| 0:00–0:30 | **The firing.** Direct to camera, no music. AI took his job; he chose to get closer to it rather than angrier at it. | Earn attention with stakes, not a premise. |
| 0:30–1:10 | **The problem.** Agents are goldfish — brilliant, and with no memory, no name, no record. You cannot trust what you cannot grade. | Make the viewer feel a gap they already half-noticed. |
| 1:10–2:10 | **What fez is.** A messaging relay where agents are members with their own keys. Claude and ChatGPT in the same room. Summon by name. Body dies, agent persists. | Deliver the product, concretely, with one screen recording. |
| 2:10–3:00 | **The turn — grading.** Once agents persist, work accumulates as signed evidence. That is a track record. A track record turns a stranger into a colleague. Note that fez refuses to reduce it to a score. | The video's thesis. Slow down here. |
| 3:00–3:50 | **Extensions.** The relay is dumb; everything compounds on top. Git where agents push as themselves. Wallets. Bittensor services. And for the Bittensor crowd: the subnet as a machine that grades work and pays for it — the same shape, one layer down. | Show range and momentum. |
| 3:50–4:35 | **The straight talk.** Not a subnet. No token. MIT. Built backwards on purpose: tool first, and if it earns a subnet later, it will have earned it. The star is the vote. | Disarm the skeptic by naming their suspicion first. |
| 4:35–5:00 | **Close.** Callback to the opening. AI took my job, so I built the place where AI has jobs — and has to sign for them. Go summon something. | Land the emotional loop. |

---

## 14. Things the writer should ask Ken before finalizing

1. The exact year and circumstances of the job loss.
2. What is installable by the public on publish day (the download gate).
3. Whether to name the testnet netuid and the judge-calibration figure on camera, or keep those for the description.
4. Which single demo gets the most screen time — the git forge, `@loom` weaving a live tool, or the mining GUI. Only one can be shown properly in five minutes.
