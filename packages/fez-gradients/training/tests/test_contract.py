import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contract import normalize_row, task_paths, load_rewards


class ContractTests(unittest.TestCase):
    def test_instruction_completion_and_custom_format(self):
        spec = {"field_instruction": "question", "field_input": "context", "field_output": "answer",
                "format": "Q: {instruction}\n{input}\nA: ", "system_prompt": "Be concise."}
        self.assertEqual(normalize_row("InstructTextTask", spec, {"question": "Why?", "context": "Given X", "answer": "Because Y"}),
                         {"prompt": "Be concise.\nQ: Why?\nGiven X\nA: ", "completion": "Because Y"})
        self.assertEqual(normalize_row("InstructTextTask", {"field_instruction": "body"}, {"body": "whole text"}), {"text": "whole text"})

    def test_chat_roles_and_preferences(self):
        self.assertEqual(normalize_row("ChatTask", {"chat_user_reference": "human", "chat_assistant_reference": "gpt"},
                                       {"conversations": [{"from": "human", "value": "Hi"}, {"from": "gpt", "value": "Hello"}]}),
                         {"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]})
        spec = {"field_prompt": "q", "field_chosen": "yes", "field_rejected": "no", "chosen_format": "{chosen}!"}
        self.assertEqual(normalize_row("DpoTask", spec, {"q": "Hi", "yes": "Hello", "no": "Bye"}),
                         {"prompt": "Hi", "chosen": "Hello!", "rejected": "Bye"})

    def test_grpo_preserves_reward_extra_column(self):
        self.assertEqual(normalize_row("GrpoTask", {"field_prompt": "question", "extra_column": "answer"},
                                       {"question": "2+2", "answer": "4"}), {"prompt": "2+2", "extra_data": "4"})
        funcs, weights = load_rewards([{"reward_func": "def score(completions, **kwargs):\n    return [float(len(c)) for c in completions]", "reward_weight": 2}])
        self.assertEqual(funcs[0](["ab", "c"]), [2.0, 1.0])
        self.assertEqual(weights, [2.0])
        for bad in [[], [{"reward_func": "print('side effect')", "reward_weight": 1}],
                    [{"reward_func": "def score(**kwargs):\n    import fez_missing_reward_dependency\n    return []", "reward_weight": 1}],
                    [{"reward_func": "def score(**kwargs): return []", "reward_weight": -1}]]:
            with self.assertRaises(ValueError):
                load_rewards(bad)

    def test_cache_and_output_paths_cannot_escape_mounts(self):
        paths = task_paths("task-1", "org/model", "result")
        self.assertEqual(tuple(map(str, paths)), ("/cache/models/org--model", "/cache/datasets/task-1_train_data.json", "/app/checkpoints/task-1/result"))
        for task, model, repo in [("../x", "m", "r"), ("t", "../../x", "r"), ("t", "m", "../r")]:
            with self.assertRaises(ValueError):
                task_paths(task, model, repo)
        with self.assertRaises(ValueError):
            normalize_row("EnvTask", {}, {})
        with self.assertRaises(ValueError):
            normalize_row("InstructTextTask", {"field_instruction": "q", "field_output": "a"}, {"q": "missing answer"})


if __name__ == "__main__":
    unittest.main()
