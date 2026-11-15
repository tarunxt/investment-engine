"""A6-16: synthetic provider telemetry; no jobs, providers or live DB calls."""
import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy.dialects import postgresql

from app.domains.runs.output_provenance import load_output_provenance, summarize_output_provenance


def event(provider="deepseek", model="deepseek-v4-flash", finished_at=None, job_id=91):
    return SimpleNamespace(actual_provider=provider, actual_model=model,
                           finished_at=finished_at, job_id=job_id)


def test_response_telemetry_retains_multiple_models_and_missing_model():
    first = datetime(2026, 10, 10, 1, tzinfo=UTC)
    last = datetime(2026, 10, 10, 2, tzinfo=UTC)
    result = summarize_output_provenance([
        event(finished_at=first), event(finished_at=last),
        event("anthropic", "claude-sonnet-4-5"), event(model=None),
    ])
    assert result == {
        "source": "api_usage_attempt_events",
        "identities": [
            {"provider": "anthropic", "model": "claude-sonnet-4-5"},
            {"provider": "deepseek", "model": None},
            {"provider": "deepseek", "model": "deepseek-v4-flash"},
        ],
        "observed_from": first, "observed_to": last,
    }


def test_no_telemetry_does_not_fabricate_identity_or_capture_dates():
    assert summarize_output_provenance([])["identities"] == []
    assert summarize_output_provenance([event(finished_at=None)])["observed_to"] is None


def test_batch_read_is_owner_and_job_scoped_and_excludes_failed_or_search_events():
    class DB:
        async def execute(self, query):
            sql = str(query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
            assert "user_id = 17" in sql
            assert "job_id IN (91)" in sql
            assert "event_kind = 'finished'" in sql
            assert "status = 'success'" in sql
            assert "phase != 'search'" in sql
            assert "provider_request_id" not in sql
            return SimpleNamespace(all=lambda: [event()])

    result = asyncio.run(load_output_provenance(DB(), user_id=17, job_ids={91}))
    assert result[91]["identities"] == [{"provider": "deepseek", "model": "deepseek-v4-flash"}]
    assert asyncio.run(load_output_provenance(None, user_id=17, job_ids=set())) == {}
