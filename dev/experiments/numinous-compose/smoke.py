"""Throwaway, offline execution check; does not forecast or submit to a subnet."""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

UPSTREAM = Path("/trial/upstream")
SANDBOX = Path("/sandbox")
HASHES = {
    "agent_runner.py": "a62e4a17d086e5eaecb65518fa3abca20d4413d30387a33db9f5720e7ca9a46b",
    "hello_world.py": "9bf54fd0321ca770e8ed06f7aa6f656afaaba4de7a397d28f12ae0a9096b38ab",
    "memory_example.py": "d4a11c354456af2eb889f30f6b88ea6fe705ab9fd898c03516d99bf841fbd493",
}


def execute(code, memory=None):
    event = {
        "event_id": "fez-offline-check",
        "title": "Synthetic interface test",
        "description": "Not a real forecast or subnet submission.",
        "cutoff": "2030-01-01T00:00:00Z",
        "metadata": {},
        "memory": memory,
    }
    (SANDBOX / "agent.py").write_text(code)
    (SANDBOX / "input.json").write_text(json.dumps(event))
    output = SANDBOX / "output.json"
    output.unlink(missing_ok=True)
    subprocess.run(
        [sys.executable, str(UPSTREAM / "agent_runner.py")],
        check=True, capture_output=True, text=True, timeout=15,
    )
    return json.loads(output.read_text())


def main():
    assert {p.name for p in Path("/sys/class/net").iterdir()} == {"lo"}, "Offline only"
    for name, expected in HASHES.items():
        assert hashlib.sha256((UPSTREAM / name).read_bytes()).hexdigest() == expected, name

    baseline = execute((UPSTREAM / "hello_world.py").read_text())
    assert baseline["status"] == "success", baseline
    assert baseline["output"]["event_id"] == "fez-offline-check", baseline
    assert baseline["output"]["prediction"] == 0.5, baseline
    print("PASS: official baseline accepted by the official agent runner")

    memory_code = (UPSTREAM / "memory_example.py").read_text()
    first = execute(memory_code, json.dumps({"belief": 0.8, "history": [0.8]}))
    assert first["status"] == "success", first
    assert math.isclose(first["output"]["prediction"], 0.68), first
    second = execute(memory_code, first["output"]["memory"])
    assert second["status"] == "success", second
    assert math.isclose(second["output"]["prediction"], 0.608), second
    assert len(json.loads(second["output"]["memory"])["history"]) == 3, second
    print("PASS: memory carried between fresh agent processes; belief 0.8 -> 0.68 -> 0.608")

    invalid = execute("def agent_main(e): return {'event_id': e['event_id'], 'prediction': 1.1}")
    assert invalid["status"] == "error", invalid
    assert "between 0.0 and 1.0" in invalid["error"], invalid
    print("PASS: out-of-range prediction rejected")
    print("OFFLINE ONLY: no inference, signing proxy, testnet upload, scoring, or rewards tested")


if __name__ == "__main__":
    main()
