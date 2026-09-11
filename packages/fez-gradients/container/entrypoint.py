import os
import sys
from fez_submission import submission_for

# Validate even for the one-shot Fiber registration, before chain access.
try:
    submission_for(os.environ.get("GRADIENTS_TOURNAMENT_TYPE", ""))
except ValueError as exc:
    sys.exit(str(exc))
if len(sys.argv) < 2:
    sys.exit("Missing miner command")
os.execvp(sys.argv[1], sys.argv[1:])
