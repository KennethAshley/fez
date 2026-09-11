"""Public training submissions; no keys, network calls, or implicit enrollment."""
import os
import re


def submission_for(task_type, env=None):
    env = os.environ if env is None else env
    if env.get("NETUID") != "241" or env.get("SUBTENSOR_NETWORK") != "test":
        raise ValueError("Gradients is testnet-only: NETUID=241 and SUBTENSOR_NETWORK=test required")
    selected = env.get("GRADIENTS_TOURNAMENT_TYPE", "")
    repo = env.get("GRADIENTS_TRAINING_REPO", "")
    commit = env.get("GRADIENTS_TRAINING_COMMIT", "")
    if selected not in ("text", "image", "environment"):
        raise ValueError("Select one Gradients tournament type")
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Training repository must be a public GitHub repository URL without credentials or query parameters")
    if not re.fullmatch(r"[a-fA-F0-9]{40}", commit):
        raise ValueError("Training commit must be a full 40-character SHA")
    if task_type != selected:
        return None
    return dict(github_repo=repo, commit_hash=commit, github_token=None, requested_datasets=None)
