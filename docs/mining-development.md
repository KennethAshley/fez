# Developing a miner with Fez

Mining setup, chat tools and the development panel use the same local miner configuration and experiment history. A miner is identified by subnet and Fez persona. Development does not enroll, start, deploy or upload it.

## In chat

Attach Mining to a coding agent, or open a submission miner in Mining to enable its mining tools. Ask:

> Inspect my Ridges setup. Create a candidate in my repository using the subnet's contract, commit the baseline, and link it to this miner. Explain the evaluator prerequisites before running anything that costs money.

`mining_setup` reads the adapter's fields and current non-secret settings. `mining_config` changes ordinary fields. Enter private credentials in the GUI setup form; secret values are refused by the chat tool.

`mining_workspace` has three actions:

- `inspect`: repository/source association, adapter instructions, recent experiments and compatible score deltas.
- `configure`: link an existing local Git repository and a relative source file. Your coding agent uses its usual file and Git tools to create and improve the source.
- `evaluate`: explicitly start the adapter's evaluator in a background job. This may use Docker, network access and paid inference; request user approval first. Follow its status with `inspect`; the GUI polls it automatically. It never submits or deploys.

## In the GUI

Submission miners expose their setup fields, including masked secret presence. Save setup writes settings without registration, upload or process startup.

In **Develop your miner**, enter the repository root and source file relative to it, then select **Link source**. Submission panels also use the linked source as the candidate for source checks and upload. An adapter with an evaluator exposes **Evaluate candidate**, followed by an explicit confirmation. Process-miner conversations also show this development panel.

An evaluation preserves a private copy of the candidate and records its SHA256, Git commit, whether the checkout has uncommitted changes, a fingerprint of ordinary settings, evaluator and dataset identity, metrics, elapsed time and cost when reported. Keys and raw subprocess errors are not recorded. Failed or interrupted evaluations never become zero scores. Changing the source during evaluation invalidates its result.

Comparisons use the latest successful compatible predecessor: same repository, source path, ordinary configuration, evaluator and dataset. Different metrics have different directions; a positive delta does not automatically mean improvement. A local score is not an earnings estimate or proof of validator approval.

The GUI shows ten recent experiments; chat/CLI returns fifty. Older records remain in `~/.fez/mining/<netuid>-<persona>/development/`. Evaluations continue independently of the initiating window or chat command. If an evaluation worker crashes, inspect the evaluator and its containers before retrying or recovering its launch/operation locks; inference may already have been billed.

## CLI

For Ridges, the task's Docker image must already contain `python3`; its local runner installs Python packages but does not install Python itself. The task also needs Git for patch application. The stock Harbor `hello-world@1.0` image lacks Python and fails before evaluation. A modified smoke task can verify the runtime, but its score is not a coding benchmark. For x86-only benchmark images on Apple Silicon, launch the evaluator with `DOCKER_DEFAULT_PLATFORM=linux/amd64`; Fez forwards this explicit Docker setting to the official runner.

```sh
fez-mine development inspect --netuid 62 --persona coder --json
fez-mine development configure --netuid 62 --persona coder --repository /absolute/repo --source agent.py --json
fez-mine development evaluate --netuid 62 --persona coder --json
```

Commit an initial baseline before evaluating. Source files must be inside the selected Git repository and at most 1 MiB. Fez does not execute source merely because it was linked.

## Custom adapters

An installed extension's `miner` part exports `SubnetMiner[]`. Its existing `config` schema supplies setup fields; `container`/`start` or `submission` supplies deployment. The optional `development` member adds creation instructions and an evaluator:

```ts
development: {
  instructions: "Describe the source contract and local evaluator prerequisites.",
  async evaluate(ctx, sourcePath) {
    // Invoke the subnet's actual isolated evaluator, never a fabricated score.
    return {
      evaluator: "official-evaluator@exact-version",
      dataset: "dataset-content-digest",
      metrics: { score: measuredScore },
      detail: "What was evaluated and any limits.",
      // costUsd only when measured by the evaluator
    };
  },
}
```

The adapter owns isolation, timeouts, scoped cleanup, dataset verification and credential-safe results. Missing evaluation support is shown explicitly. Source checks and local performance evaluation remain different actions.
