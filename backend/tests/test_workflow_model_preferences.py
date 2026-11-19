from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.core.recovery import recovery_http_allowed
from app.domains.auth.router import get_workflow_models, update_workflow_models
from app.domains.auth.workflow_models import StageModelSelection
from test_auto_rebalance_audit_durability import audit_db, anyio_backend, OWNER


@pytest.mark.anyio
async def test_model_choices_persist_per_owner_and_stage_including_empty(audit_db):
    other = SimpleNamespace(id=8)
    deepseek = "deepseek::deepseek-v4-flash"
    async with audit_db.sessions() as db:
        assert await get_workflow_models(OWNER, db) == {}
        for user, stage, keys in [
            (OWNER, "swing", [deepseek, deepseek]),
            (other, "swing", ["other::model"]),
            (OWNER, "technical", [deepseek]),
            (OWNER, "technical", []),
        ]:
            choice = StageModelSelection(stage=stage, keys=keys)
            assert await update_workflow_models(choice, user, db) == choice
    async with audit_db.sessions() as db:
        assert await get_workflow_models(OWNER, db) == {"swing": [deepseek, deepseek], "technical": []}
        assert await get_workflow_models(other, db) == {"swing": ["other::model"]}


@pytest.mark.parametrize("payload", [
    {"stage": "sync", "keys": []}, {"stage": "threats", "keys": ["a::b"] * 2},
    {"stage": "swing", "keys": ["a::b"] * 9}, {"stage": "swing", "keys": ["::x"]},
    {"stage": "swing", "keys": [], "user_id": 8},
])
def test_only_stage_selections_accepted(payload):
    with pytest.raises(ValidationError):
        StageModelSelection(**payload)


def test_recovery_write_is_specific_to_workflow_model_preferences():
    assert recovery_http_allowed("PUT", "/auth/profile/workflow-models")
    assert not recovery_http_allowed("PUT", "/auth/profile")
    assert not recovery_http_allowed("PUT", "/auth/profile/workflow-models/extra")
