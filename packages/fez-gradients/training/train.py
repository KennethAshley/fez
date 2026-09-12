"""Small Gradients.io text trainer. Network and wallet actions belong to Fez."""
import argparse
import inspect
import json
import math
import os
from pathlib import Path
import time

from contract import TASK_TYPES, load_rewards, normalize_row, task_paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("task-id", "model", "dataset", "dataset-type", "expected-repo-name"):
        parser.add_argument(f"--{key}", required=True)
    parser.add_argument("--task-type", required=True, choices=TASK_TYPES)
    parser.add_argument("--file-format", required=True, choices=["s3"])
    parser.add_argument("--hours-to-complete", required=True, type=float)
    parser.add_argument("--cache-root", default="/cache")
    parser.add_argument("--output-root", default="/app/checkpoints")
    parser.add_argument("--cpu", action="store_true", help="Local tiny-model verification only")
    parser.add_argument("--max-steps", type=int, default=-1)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--epochs", type=float, default=1)
    parser.add_argument("--lora-rank", type=int, default=16)
    args = parser.parse_args()
    for name in ("hours_to_complete", "learning_rate", "epochs"):
        if not math.isfinite(getattr(args, name)) or getattr(args, name) <= 0:
            parser.error(f"{name} must be finite and positive")
    if args.max_length < 8 or args.lora_rank < 1 or args.max_steps == 0 or args.max_steps < -1:
        parser.error("Invalid length, LoRA rank, or max-steps")
    kl_coef = float(os.environ.get("KL_COEF", "0.1")) if os.environ.get("USE_KL") == "1" else 0
    if not math.isfinite(kl_coef) or kl_coef < 0:
        parser.error("KL_COEF must be finite and nonnegative")
    budget = args.hours_to_complete * 3600
    deadline = time.monotonic() + budget - min(60, budget * 0.1)
    model_path, data_path, output = task_paths(args.task_id, args.model, args.expected_repo_name, args.cache_root, args.output_root)
    if not model_path.is_dir() or not data_path.is_file():
        raise ValueError("Validator-cached model or dataset missing; downloads are disabled")
    if output.exists():
        raise ValueError("Output already exists; refusing to replace a previous submission")
    spec = json.loads(args.dataset_type)
    if not isinstance(spec, dict):
        raise ValueError("dataset-type must be a JSON object")
    work = output.parent / f".{output.name}-work"
    work.mkdir(parents=True, exist_ok=False)
    os.environ.update(HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      WANDB_MODE="offline", HF_HOME=str(work / "hf"), HF_DATASETS_CACHE=str(work / "datasets"))
    rewards, weights = load_rewards(spec.get("reward_functions")) if args.task_type == "GrpoTask" else ([], [])

    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback
    from trl import DPOConfig, DPOTrainer, GRPOConfig, GRPOTrainer, SFTConfig, SFTTrainer
    from trl.trainer.utils import disable_dropout_in_model

    if args.cpu:
        torch.set_num_threads(2)
    elif not torch.cuda.is_available():
        raise ValueError("CUDA GPU required for validator training; use --cpu only for the local smoke check")
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token is None:
        if tokenizer.eos_token is None:
            raise ValueError("Tokenizer needs a padding or EOS token")
        tokenizer.pad_token = tokenizer.eos_token
    if args.task_type == "ChatTask":
        template = spec.get("chat_template") or "chatml"
        if template == "chatml":
            tokenizer.chat_template = "{% for message in messages %}{{ '<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>\n' }}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}"
        elif template != "tokenizer_default" or not tokenizer.chat_template:
            raise ValueError("Starter supports chatml or tokenizer_default chat templates")
    raw = load_dataset("json", data_files=str(data_path), split="train", cache_dir=str(work / "datasets"))
    if len(raw) == 0:
        raise ValueError("Training dataset is empty")
    dataset = raw.map(lambda row: normalize_row(args.task_type, spec, row), remove_columns=raw.column_names)
    dtype = torch.float32 if args.cpu else (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
    model = AutoModelForCausalLM.from_pretrained(model_path, local_files_only=True, trust_remote_code=False, torch_dtype=dtype)
    if args.task_type == "GrpoTask" and "logits_to_keep" not in inspect.signature(model.forward).parameters:
        raise ValueError("GRPO requires a model supporting logits_to_keep, such as Llama or Qwen2")
    if kl_coef:
        disable_dropout_in_model(model)
    model.config.use_cache = False
    peft = LoraConfig(r=args.lora_rank, lora_alpha=2 * args.lora_rank, target_modules="all-linear", task_type="CAUSAL_LM")

    class Deadline(TrainerCallback):
        # ponytail: stop at step boundaries; the validator's container timeout is the hard limit.
        def on_step_end(self, args, state, control, **kwargs):
            if time.monotonic() >= deadline:
                control.should_training_stop = True
            return control

    class RegularizedSFT(SFTTrainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            mask = inputs["labels"][:, 1:] != -100
            if not mask.any(dim=-1).all():
                raise ValueError("Example has no supervised tokens after truncation; shorten prompts or increase max-length")
            loss, outputs = super().compute_loss(model, inputs, return_outputs=True, num_items_in_batch=num_items_in_batch)
            if kl_coef:
                with torch.no_grad(), model.disable_adapter():
                    ref = model(**{key: value for key, value in inputs.items() if key != "labels"}).logits
                current_log = outputs.logits[:, :-1].float().log_softmax(-1)
                reference_log = ref[:, :-1].float().log_softmax(-1)
                divergence = torch.nn.functional.kl_div(reference_log, current_log, log_target=True, reduction="none").sum(-1)
                # Use CE's accumulation-window denominator, not just this microbatch's tokens.
                denominator = num_items_in_batch if self.model_accepts_loss_kwargs and num_items_in_batch is not None else mask.sum()
                loss = loss + kl_coef * (divergence * mask).sum() / denominator
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite training loss; refusing an invalid optimization step")
            return (loss, outputs) if return_outputs else loss

    common = dict(output_dir=str(work / "trainer"), learning_rate=args.learning_rate, num_train_epochs=args.epochs,
                  max_steps=args.max_steps, per_device_train_batch_size=2 if args.task_type == "GrpoTask" else 1,
                  gradient_accumulation_steps=1 if args.cpu else 8, use_cpu=args.cpu,
                  bf16=dtype == torch.bfloat16, fp16=dtype == torch.float16,
                  gradient_checkpointing=not args.cpu, gradient_checkpointing_kwargs={"use_reentrant": False},
                  save_strategy="no", report_to="none", logging_steps=1, seed=42, dataloader_pin_memory=not args.cpu)
    kwargs = dict(model=model, train_dataset=dataset, processing_class=tokenizer, peft_config=peft, callbacks=[Deadline()])
    if args.task_type in ("InstructTextTask", "ChatTask"):
        trainer = RegularizedSFT(args=SFTConfig(**common, max_length=args.max_length), **kwargs)
    elif args.task_type == "DpoTask":
        trainer = DPOTrainer(args=DPOConfig(**common, max_length=args.max_length, max_prompt_length=args.max_length // 2), **kwargs)
    else:
        tokenizer.padding_side = "left"
        completion_length = min(256, args.max_length // 2)
        trainer = GRPOTrainer(args=GRPOConfig(**common, num_generations=2, max_prompt_length=args.max_length - completion_length,
                                              max_completion_length=completion_length, reward_weights=weights, use_vllm=False),
                              reward_funcs=rewards, **kwargs)
    if time.monotonic() >= deadline:
        raise TimeoutError("Task budget exhausted during initialization")
    result = trainer.train()
    if trainer.state.global_step == 0 or not math.isfinite(result.training_loss):
        raise RuntimeError("Training produced no valid optimization steps")
    final = work / "final"
    merged = trainer.accelerator.unwrap_model(trainer.model).merge_and_unload(safe_merge=True)
    merged.config.use_cache = True
    merged.save_pretrained(final, safe_serialization=True)
    tokenizer.save_pretrained(final)
    summary = {"task_type": args.task_type, "steps": trainer.state.global_step, "training_loss": result.training_loss}
    (final / "training-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    final.rename(output)
    print(json.dumps({**summary, "output": str(output)}), flush=True)


if __name__ == "__main__":
    main()
