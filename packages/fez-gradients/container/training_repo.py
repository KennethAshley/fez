"""G.O.D's authenticated route, with the submission supplied by Fez config."""
from fastapi import Depends, HTTPException
from fastapi.routing import APIRouter
from fiber.miner.dependencies import blacklist_low_stake, verify_get_request
from core.models.payload_models import TrainingRepoResponse
from core.models.tournament_models import TournamentType
from fez_submission import submission_for


async def get_training_repo(task_type: TournamentType) -> TrainingRepoResponse:
    payload = submission_for(task_type.value)
    if payload is None:
        raise HTTPException(status_code=404, detail="Not participating in this tournament type")
    return TrainingRepoResponse(**payload)


def factory_router() -> APIRouter:
    router = APIRouter()
    router.add_api_route(
        "/training_repo/{task_type}", get_training_repo,
        methods=["GET"], response_model=TrainingRepoResponse,
        dependencies=[Depends(blacklist_low_stake), Depends(verify_get_request)],
    )
    return router
