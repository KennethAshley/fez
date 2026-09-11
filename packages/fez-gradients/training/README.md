# Fez Gradients text-training starter

A standalone training submission for a **testnet SN241 rehearsal**, implementing
the [Gradients.io training contract](https://github.com/gradients-ai/G.O.D/blob/c4cf8f41a9c773bb6356ce8175bae8f632e74669/docs/miner.md).
Attribution: Gradients.io is owned by Grads LLC. LICENSE.md and NOTICE are retained
unchanged from that contract revision, as the validator requires.

This directory becomes the root of the training GitHub repository. It is separate
from Fez's published **serving image**: the serving image advertises this repository
and its exact commit; validators build this directory and run training on their GPUs.
This code performs no registration, payment, wallet, or blockchain operations.

## Training behavior

- Instruction/completion and ChatTask: TRL supervised fine-tuning with LoRA.
  Instruction tasks honor the validator's optional USE_KL and KL_COEF penalty.
- DpoTask: TRL DPO with the validator's chosen/rejected examples.
- GrpoTask: TRL GRPO with supported validator Python reward functions and weights;
  the configured extra column is supplied to rewards as `extra_data`.
- Read model and dataset from `/cache`; never download replacements. Save merged
  model weights and tokenizer to `/app/checkpoints/{task_id}/{expected_repo_name}`
  only after successful optimization. Errors produce no fabricated model.

The training entrypoint accepts the validator's documented CLI arguments.
`--dataset` is accepted for compatibility; its URL is never fetched. Models load
from `/cache/models/{model_id with slashes replaced by double hyphens}`, and data
from `/cache/datasets/{task_id}_train_data.json`. Hashed model names also work.

## Scope and limits

This is a starting recipe, not a claim of tournament eligibility or competitive
performance. A real validator/GPU run and score comparison are still required.
The pinned Transformers version supports its known causal-LM architectures;
newer/custom-code and multimodal architectures fail explicitly. GRPO additionally
requires `logits_to_keep` support (for example Llama or Qwen2); GPT-2 is rejected.
Chat formatting supports `chatml` and `tokenizer_default`.
Environment/image tournaments are excluded.

The starter uses one process/GPU, unquantized base weights, and merged LoRA output;
models that do not fit that GPU require a tested distributed/quantized recipe.
Deadlines stop at optimization-step boundaries and reserve time for saving; the
validator's container timeout remains the hard limit. One epoch is the initial
recipe. Datasets and models must be provided by the validator.

GRPO reward strings are executable Python supplied by the validator. Run training
inside an isolated container with no wallet/credential mounts and no public network.
The reward-loader check is input validation, **not** a Python security sandbox.
Reward imports must already exist in the image; missing imports are rejected before
loading model weights. Optional upstream reward dependencies such as `textstat` and
`langcheck` are not bundled. Add and test those dependencies in a new recipe before
submitting tasks that require them; runtime downloads are not a fallback.

Tune the defaults in `train.py` (`--learning-rate`, `--epochs`, `--max-length`, and
`--lora-rank`), test, then publish a new commit. Fez's GUI selects the commit;
it does not hot-edit training code or pass these optional recipe arguments.
Changes intended for competition need actual training improvements; cosmetic
differences do not satisfy Gradients' duplicate-submission rules.

## Checks

Verified on 2026-09-09: all four tiny-model CPU training modes completed and their
saved weights reloaded; the input cache stayed unchanged. Contract checks passed,
and Fez's integration gate passed 1,418 tests (one skipped). The Linux/AMD64 Docker
build and the same four-mode CPU smoke test also passed on the existing build host,
running without networking or root, with a read-only filesystem, 1 CPU and 2 GB RAM.
A real CUDA/validator run remains unverified.

Verified local test image: `fez-gradients-training:smoke-20260909`, image ID
`sha256:95243b092bbc69e312bd697e5dcd3aa730eed32a54adcf220d1d0220d00e2c76`.
This image has not been published and its ID is not a training Git commit.

From this directory:

```sh
python3 -m unittest discover -s tests
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python tests/smoke_training.py
```

The smoke check generates its own tiny Llama model/tokenizer/data and runs two real CPU
optimization steps for every supported task type (including instruction KL).
It reloads the outputs, checks instruction/chat/DPO weights changed, rejects prompts
whose completions are entirely truncated, and verifies input-cache bytes are unchanged.
It neither downloads models nor contacts a chain.
This CPU check does **not** validate GPU execution or performance on tournament models.

On a Docker host, build using the path the validator discovers:

```sh
docker build -f ops/docker/standalone-text-trainer.dockerfile -t fez-gradients-training .
docker run --rm --network none --read-only --user 65534:65534 \
  --cpus 1 --memory 2g --memory-swap 2g --pids-limit 128 \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,size=536870912,mode=1777 \
  -e HOME=/tmp -e HF_HOME=/tmp/hf -e OMP_NUM_THREADS=2 -e MKL_NUM_THREADS=2 \
  -v "$PWD/tests:/app/tests:ro" --entrypoint python \
  fez-gradients-training /app/tests/smoke_training.py
```

The public CUDA base image and top-level Python dependency versions are pinned by
version. The base image is a tag, not an immutable digest; transitive dependency
resolution is not fully locked. Record an actual successful GPU build/run before
treating the recipe as production-ready.

## Use in Fez

Training repository: https://github.com/KennethAshley/fez-gradients-training

Use that URL and the full 40-character commit SHA (`git rev-parse HEAD` in this
repository) in Fez's **Gradients testnet SN241** config with tournament type `text`.
Keep LICENSE.md and NOTICE when publishing an updated training recipe.
Do not substitute the serving-image digest for the training commit.
