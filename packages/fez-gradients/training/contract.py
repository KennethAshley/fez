"""Gradients.io's cached text-task contract, without ML dependencies."""
import ast
import importlib.util
import math
import re
from pathlib import Path

TASK_TYPES = ("InstructTextTask", "ChatTask", "DpoTask", "GrpoTask")


def task_paths(task_id, model, repo, cache_root="/cache", output_root="/app/checkpoints"):
    for value in (task_id, repo, model.replace("/", "--")):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value) or ".." in value:
            raise ValueError("Task, model and output identifiers must not escape their directories")
    cache = Path(cache_root).resolve()
    output = Path(output_root).resolve()
    candidates = (cache / "models" / model.replace("/", "--"), cache / "datasets" / f"{task_id}_train_data.json", output / task_id / repo)
    for candidate, root in zip(candidates, (cache, cache, output)):
        if not candidate.resolve().is_relative_to(root):
            raise ValueError("Input or output symlink escapes its mount")
    return candidates


def normalize_row(kind, spec, row):
    def field(key, fallback=None, optional=False):
        name = spec.get(key) or fallback
        if not name and optional:
            return ""
        if not name or name not in row or not isinstance(row[name], str):
            raise ValueError(f"Missing or non-text dataset column: {key}")
        return row[name]

    if kind == "InstructTextTask":
        instruction = field("field_instruction", spec.get("field"))
        if not spec.get("field_output"):
            return {"text": instruction}
        context = field("field_input", optional=True)
        system = field("field_system", optional=True) or spec.get("system_prompt") or ""
        template = (spec.get("format") or "{instruction} {input}") if context else (spec.get("no_input_format") or "{instruction}")
        prompt = template.format(instruction=instruction, input=context)
        if system:
            prompt = (spec.get("system_format") or "{system}").format(system=system) + "\n" + prompt
        return {"prompt": prompt, "completion": field("field_output")}
    if kind == "ChatTask":
        messages = row.get(spec.get("chat_column") or "conversations")
        if not isinstance(messages, list) or not messages:
            raise ValueError("Chat task needs a nonempty conversation")
        roles = {"system": "system", spec.get("chat_user_reference") or "user": "user", spec.get("chat_assistant_reference") or "assistant": "assistant"}
        out = []
        for message in messages:
            if not isinstance(message, dict):
                raise ValueError("Chat message must be an object")
            role = roles.get(message.get(spec.get("chat_role_field") or "from"))
            content = message.get(spec.get("chat_content_field") or "value")
            if not role or not isinstance(content, str):
                raise ValueError("Unknown chat role or non-text content")
            out.append({"role": role, "content": content})
        return {"messages": out}
    if kind == "DpoTask":
        values = {"prompt": field("field_prompt", "prompt"), "chosen": field("field_chosen", "chosen"),
                  "rejected": field("field_rejected", "rejected"), "system": field("field_system", optional=True)}
        return {key: (spec.get(f"{key}_format") or "{" + key + "}").format(**values) for key in ("prompt", "chosen", "rejected")}
    if kind == "GrpoTask":
        out = {"prompt": field("field_prompt", "prompt")}
        extra = spec.get("extra_column")
        if extra:
            if extra not in row or extra in ("prompt", "prompts", "completions", "completion_ids"):
                raise ValueError("Missing or reserved GRPO extra column")
            out["extra_data"] = row[extra]
        return out
    raise ValueError(f"Unsupported task type: {kind}")


def load_rewards(specs):
    # Validator-supplied Python is executable code, not a security sandbox.
    # Run this only in the validator's isolated container with no wallet keys.
    if not isinstance(specs, list) or not specs:
        raise ValueError("GRPO requires the validator's reward functions")
    funcs, weights = [], []
    for spec in specs:
        weight = float(spec["reward_weight"])
        if not math.isfinite(weight) or weight < 0:
            raise ValueError("Reward weights must be finite and nonnegative")
        tree = ast.parse(spec["reward_func"])
        definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
        if len(definitions) != 1 or any(not isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef)) for node in tree.body):
            raise ValueError("Each reward must define one function, with optional imports")
        for node in ast.walk(tree):
            modules = [alias.name for alias in node.names] if isinstance(node, ast.Import) else ([node.module] if isinstance(node, ast.ImportFrom) else [])
            for module in modules:
                try:
                    available = module and importlib.util.find_spec(module) is not None
                except (ImportError, ValueError):
                    available = False
                if not available:
                    raise ValueError(f"Reward dependency is not installed: {module}")
        namespace = {}
        exec(compile(tree, "<validator reward>", "exec"), namespace)
        funcs.append(namespace[definitions[0].name])
        weights.append(weight)
    if not any(weights):
        raise ValueError("At least one reward weight must be positive")
    return funcs, weights
