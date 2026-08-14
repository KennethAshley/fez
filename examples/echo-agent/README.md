# Echo Agent

The simplest possible Agent-Nostr agent. It receives tasks and replies with the task content echoed back.

## Purpose

- Demonstrates the ACP subprocess contract
- Tests the agent-acp harness end-to-end
- Serves as a template for new agents

## Implementation

```python
#!/usr/bin/env python3
import json
import sys

def handle_prompt(params):
    instruction = params.get("instruction", "")
    return {
        "output": f"Echo: {instruction}",
        "status": "success"
    }

def main():
    for line in sys.stdin:
        req = json.loads(line)
        method = req.get("method")
        req_id = req.get("id")

        if method == "initialize":
            response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "capabilities": ["session/prompt"]
                }
            }
        elif method == "session/prompt":
            result = handle_prompt(req.get("params", {}))
            response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": result
            }
        else:
            response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": "Method not found"}
            }

        print(json.dumps(response), flush=True)

if __name__ == "__main__":
    main()
```

## Running

```bash
# Start the relay
just relay

# In another terminal, run the agent via the harness
agent-acp --relay ws://localhost:3000 --agent ./echo_agent.py --key-file echo.key

# In another terminal, send a task
agent-cli task --agent <echo-pubkey> --type echo --instruction "Hello world"
```
