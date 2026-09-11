"""Real tiny-model training, fully offline; run with the pinned requirements."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

os.environ.update(HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", WANDB_MODE="offline")
import torch
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import WhitespaceSplit
from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast

ROOT = Path(__file__).resolve().parents[1]
torch.set_num_threads(2)

with tempfile.TemporaryDirectory(prefix="gradients-train-smoke-") as tmp:
    root = Path(tmp)
    cache = root / "cache"
    model_dir = cache / "models" / "tiny"
    model_dir.mkdir(parents=True)
    (cache / "datasets").mkdir()
    vocab = {word: i for i, word in enumerate(["<pad>", "<bos>", "<eos>", "<unk>", "hello", "world", "good", "bad", "say", "hi", "answer", "yes", "no", "one", "two", "three"])}
    backend = Tokenizer(WordLevel(vocab, unk_token="<unk>"))
    backend.pre_tokenizer = WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, bos_token="<bos>", eos_token="<eos>", unk_token="<unk>", pad_token="<pad>")
    tokenizer.save_pretrained(model_dir)
    model = LlamaForCausalLM(LlamaConfig(vocab_size=len(vocab), num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=2,
                                       hidden_size=16, intermediate_size=32, max_position_embeddings=64,
                                       bos_token_id=1, eos_token_id=2, pad_token_id=0))
    model.save_pretrained(model_dir)
    weights = {name: value.clone() for name, value in model.state_dict().items()}
    cases = [
        ("InstructTextTask", {"field_instruction": "q", "field_output": "a"}, {"q": "say hello", "a": "hello world"}),
        ("ChatTask", {}, {"conversations": [{"from": "user", "value": "say hi"}, {"from": "assistant", "value": "hello world"}]}),
        ("DpoTask", {}, {"prompt": "say hello", "chosen": "hello world good", "rejected": "bad no"}),
        ("GrpoTask", {"field_prompt": "q", "extra_column": "answer", "reward_functions": [{"reward_func": "def reward(completions, extra_data, **kwargs):\n    assert all(x == 'yes' for x in extra_data)\n    return [float(len(set(c))) for c in completions]", "reward_weight": 1}]}, {"q": "say hi", "answer": "yes"}),
    ]
    for kind, spec, row in cases:
        data = cache / "datasets" / f"{kind}_train_data.json"
        data.write_text(json.dumps([row] * 4))
    (cache / "datasets" / "truncated_train_data.json").write_text(json.dumps([{"q": "hello " * 80, "a": "yes"}] * 4))
    before = {str(p.relative_to(cache)): hashlib.sha256(p.read_bytes()).hexdigest() for p in cache.rglob("*") if p.is_file()}
    for kind, spec, row in cases:
        command = [sys.executable, str(ROOT / "train.py"), "--task-id", kind, "--model", "tiny", "--dataset", "https://never-fetch.invalid/data",
                   "--dataset-type", json.dumps(spec), "--task-type", kind, "--file-format", "s3", "--expected-repo-name", "result", "--hours-to-complete", "0.25",
                   "--cache-root", str(cache), "--output-root", str(root / "out"), "--cpu", "--max-steps", "2", "--max-length", "32"]
        env = {**os.environ, "USE_KL": "1" if kind == "InstructTextTask" else "0", "KL_COEF": "0.1"}
        subprocess.run(command, env=env, check=True, timeout=120)
        output = root / "out" / kind / "result"
        trained = LlamaForCausalLM.from_pretrained(output, local_files_only=True)
        assert (output / "tokenizer.json").is_file()
        assert json.loads((output / "training-summary.json").read_text())["steps"] == 2
        if kind != "GrpoTask":  # Tiny sampled rewards can be equal; SFT/DPO must update weights.
            assert any(not torch.equal(weights[name], value) for name, value in trained.state_dict().items()), kind
        print(f"PASS: {kind} saved a reloadable model", flush=True)
    invalid = command.copy()
    for key, value in {"--task-id": "truncated", "--task-type": "InstructTextTask", "--dataset-type": json.dumps({"field_instruction": "q", "field_output": "a"})}.items():
        invalid[invalid.index(key) + 1] = value
    rejected = subprocess.run(invalid, env=env, text=True, capture_output=True, timeout=120)
    assert rejected.returncode != 0 and "no supervised tokens" in rejected.stderr, rejected.stderr
    assert not (root / "out" / "truncated" / "result").exists()
    print("PASS: truncated completion fails without publishing unchanged weights", flush=True)
    after = {str(p.relative_to(cache)): hashlib.sha256(p.read_bytes()).hexdigest() for p in cache.rglob("*") if p.is_file()}
    assert before == after, "Trainer changed the read-only input cache"
    print("PASS: all inputs unchanged; no download or blockchain actions", flush=True)
