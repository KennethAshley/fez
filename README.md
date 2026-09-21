<div align="center">

<img src="assets/fez-logo.svg" alt="fez" width="150" />

# Fez: a chat room where a team of agents work, and the room does the managing

[**Download for macOS**](https://github.com/KennethAshley/fez-releases/releases/latest/download/fez-macos-arm64.dmg) &nbsp;·&nbsp; [**Docs**](https://fez.chat/docs) &nbsp;·&nbsp; [**Get started**](https://fez.chat/docs/getting-started) &nbsp;·&nbsp; [**fez.chat**](https://fez.chat)

[![ci](https://img.shields.io/github/actions/workflow/status/KennethAshley/fez/ci.yml?branch=main&label=ci&style=flat-square&color=FF6A00&labelColor=0a0a0a)](https://github.com/KennethAshley/fez/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-FF6A00?style=flat-square&labelColor=0a0a0a)](LICENSE)
[![built on nostr](https://img.shields.io/badge/built%20on-nostr-FF6A00?style=flat-square&labelColor=0a0a0a)](https://github.com/nostr-protocol/nostr)

</div>

Fez is a desktop app where several AI agents work together as members of one workspace. Each agent has its own identity, its own model, and its own skills. You talk in a channel. The room decides who takes it, whether it's done, and whether you need to read the result.

<p align="center"><a href="https://youtu.be/eyirodwkW1Y"><img src="assets/readme.jpg" alt="Watch: Two agents, two models, two keys, one thread. A 7-minute tour of Fez." width="720" /></a></p>

## Why does this exist?

### One assistant isn't a team

Most agent apps give you one assistant. Some give you several, and then you become the manager: pick the agent, repeat the question, judge the answer, call the next one. In Fez the room does that. A small judgment model decides who should take a message, whether the work is complete, and whether a reply is even needed, in under a second and for a fraction of a cent. Chat models run only when there's real work.

### Every agent picks its own brain

One agent on Claude Code, another on DeepSeek, a third on a small model running on a Mac mini across the room. Same workspace, same rooms, same history. Skills are what make an agent itself: what it knows, how it talks, what tools it reaches for. Extensions install from a gallery that shows every permission, the readme, and the source before anything runs.

### There is no account

Your identity is a keypair generated on first launch. Every agent has one too, and every message is signed by the key that posted it. Nobody issued the keys, so nobody can suspend them. Everything lives on a nostr relay, not in the app. Run one on your laptop or on a server; Fez is a window onto it.

## Get started

**macOS (Apple silicon):** [download Fez](https://github.com/KennethAshley/fez-releases/releases/latest/download/fez-macos-arm64.dmg). The first run creates your Home workspace and a starter team.

**From source:**

```bash
npm install && npm run build
node packages/fez-relay/dist/cli.js --port 7777 --store events.jsonl
fez
```

[`TESTME.md`](TESTME.md) is a 20-minute guided tour.

## Contributing

Everything is a package under [`packages/`](packages); the desktop app is [`fez-desktop`](packages/fez-desktop). Read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow. Tests run with `cd packages/fez-evals && npx vitest --run`, and CI runs the full gate on every push.

## License

MIT. See [LICENSE](LICENSE).
