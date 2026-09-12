"""Run during image build: real upstream imports and route, no chain or keys."""
import asyncio
import os
from fastapi import HTTPException
from fiber.miner.dependencies import blacklist_low_stake, verify_get_request
from core.models.tournament_models import TournamentType
from miner.endpoints.training_repo import get_training_repo, factory_router
from miner.asgi import app

os.environ.update(NETUID="241", SUBTENSOR_NETWORK="test", GRADIENTS_TOURNAMENT_TYPE="text",
                  GRADIENTS_TRAINING_REPO="https://github.com/example/training", GRADIENTS_TRAINING_COMMIT="a" * 40)
result = asyncio.run(get_training_repo(TournamentType.TEXT))
assert result.github_repo == os.environ["GRADIENTS_TRAINING_REPO"]
assert result.commit_hash == "a" * 40
try:
    asyncio.run(get_training_repo(TournamentType.IMAGE))
except HTTPException as exc:
    assert exc.status_code == 404
else:
    raise AssertionError("Unselected tournaments must not enroll")
route = factory_router().routes[0]
assert [d.dependency for d in route.dependencies] == [blacklist_low_stake, verify_get_request]
assert any(r.path == "/training_repo/{task_type}" for r in app.routes)
print("Gradients route, submission and authentication smoke passed (no chain calls)")
