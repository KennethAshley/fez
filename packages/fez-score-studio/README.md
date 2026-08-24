# @fezchat/score-studio

A fez extension that ships **@score** — an evidence-gated computer-vision
architect for [Score Studio](https://github.com/score-technologies), the
platform for production vision systems (datasets → annotation → training/VLM
fine-tuning → evaluation with release gates → deployment → monitoring).

Adapted from Score Technologies' **Apache-2.0** [Score Studio Cursor plugin](https://github.com/score-technologies/score-studio-cursor-plugin)
— the architect persona, integration rules, four command workflows, and release
gates, ported into a fez persona.

## What @score does

Four modes, invoked in plain language (`@score plan a defect detector`,
`@score release-check this workflow`):

- **plan** — turn a vision objective + constraints into the smallest credible
  system, built around a measurable evaluation contract.
- **integrate** — implement the smallest vertical slice against the project's
  own `scorestudio` SDK / OpenAPI (never a hardcoded API).
- **workflow** — compose the typed graph (inputs → models/VLMs → logic → eval →
  deploy → monitor) with gates before deployment and feedback after.
- **release-check** — `ready` / `conditional` / `blocked` against the release
  gates; never turns missing evidence into a pass.

The throughline is **evidence-gating**: design around a contract, prove the
thing meets it before release, keep proving it after.

## Install

```
fez install @fezchat/score-studio
```

Seeds `~/.fez/personas/score.md`. Mention **@score** in any channel to summon it.

## Notes

- **Knowledge-only, like the source plugin.** No MCP server, no bundled API —
  @score uses *your* project's installed SDK / live OpenAPI as the source of
  truth, and reads `SCORESTUDIO_URL` / `SCORESTUDIO_TOKEN` from the environment
  or secret store. It needs no Score Studio account to install.
- **To let @score edit a real repo:** fez agents run in their own workdir, so
  for the `integrate`/`workflow` modes give it your project — set `workdir:
  /path/to/project` in `~/.fez/personas/score.md`, or adopt the repo via
  `fez-git`. Without that, @score works as an architect/reviewer over context
  you bring it (great for `plan` and `release-check`).
- **Harness:** defaults to `claude-code` (this is coding-architect work). Switch
  to the Built-in agent in the editor if you prefer.

Apache-2.0, following the upstream plugin's license.
