"""Read-only provenance contract; no database writes or provider activity."""
from datetime import datetime, timezone
from types import SimpleNamespace
from app.domains.runs.schemas import RunResponse, RunCreate
from app.shared.types import JobStatus


def test_recorded_module_binding_is_serialized_without_granting_creation_control():
    value = SimpleNamespace(id=1, prompt='synthetic saved source', status=JobStatus.COMPLETED,
                            current_stage=0, run_jobs=[], created_at=datetime.now(timezone.utc),
                            updated_at=datetime.now(timezone.utc), module_id='indmoney_us', module_version=7)
    result = RunResponse.model_validate(value).model_dump()
    assert (result['module_id'], result['module_version']) == ('indmoney_us', 7)
    assert 'module_id' not in RunCreate.model_fields
    assert 'module_version' not in RunCreate.model_fields


def test_legacy_null_or_absent_binding_never_becomes_a_current_policy_version():
    for attribution in ({}, {'module_id': None, 'module_version': None}):
        value = dict(id=1, prompt='synthetic legacy source', status=JobStatus.COMPLETED,
                     current_stage=0, run_jobs=[], created_at=datetime.now(timezone.utc),
                     updated_at=datetime.now(timezone.utc), **attribution)
        result = RunResponse.model_validate(value).model_dump()
        assert result['module_id'] is None
        assert result['module_version'] is None
