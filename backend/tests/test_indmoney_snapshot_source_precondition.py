"""Saved-source identity guard. Queue/DB are deterministic fakes; no providers."""
import asyncio
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from app.domains.indmoney_us import threats_router as routes
from app.domains.indmoney_us.threats_schemas import IndMoneyUsThreatRunRequest


def snapshot(snapshot_id=87):
    return SimpleNamespace(
        id=snapshot_id, captured_at=datetime(2026, 11, 1, 8, 28, 10, tzinfo=timezone.utc),
        snapshot_date=date(2026, 11, 1), source="manual_paste", parse_status="parsed",
        parse_warnings=[], reported_holdings_count=1, holdings_count=1,
        holdings=[{"symbol": "SYNTH", "company_name": "Synthetic", "quantity": 0}],
        wallet_balance=0, current_value=0, invested_value=None, day_return_value=None,
        day_return_percent=None, total_return_value=None, total_return_percent=None, market_indices=[],
    )


def setup_route(monkeypatch, latest):
    lookup = AsyncMock(return_value=latest)
    monkeypatch.setattr(routes, "IndMoneyUsPortfolioSnapshotRepository", lambda db: SimpleNamespace(get_latest_by_user=lookup))
    monkeypatch.setattr(routes, "_resolve_threat_target", AsyncMock(return_value=("synthetic", "fixture")))
    redis = SimpleNamespace(aclose=AsyncMock())
    monkeypatch.setattr(routes, "_get_redis", lambda: redis)
    execute = AsyncMock(return_value=SimpleNamespace(job_id=501))
    monkeypatch.setattr(routes, "CreateJobUseCase", lambda **kwargs: SimpleNamespace(execute=execute))
    job = SimpleNamespace(id=501, status="pending", provider="synthetic", model="fixture", created_at=datetime(2026, 11, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(routes, "PostgresJobRepository", lambda db: SimpleNamespace(get_for_user=AsyncMock(side_effect=lambda job_id, user_id: job if (job_id, user_id) == (501, 11) else None)))
    return lookup, execute, redis


@pytest.mark.parametrize("expected", [87, None, "no-body"])
def test_matching_or_legacy_request_uses_actual_latest_prompt_and_response(monkeypatch, expected):
    latest = snapshot()
    before = repr(latest)
    lookup, execute, redis = setup_route(monkeypatch, latest)
    body = None if expected == "no-body" else IndMoneyUsThreatRunRequest(expected_snapshot_id=expected)
    response = asyncio.run(routes.run_threat_analysis(body, object(), SimpleNamespace(id=11)))
    assert response.snapshot_id == 87
    assert response.captured_at == latest.captured_at
    lookup.assert_awaited_once_with(11)
    command = execute.await_args.args[0]
    assert "[INDMONEY_THREAT_SNAPSHOT_ID=87]" in command.prompt
    assert latest.captured_at.isoformat() in command.prompt
    assert repr(latest) == before
    redis.aclose.assert_awaited_once()


@pytest.mark.parametrize("latest,expected,status", [(snapshot(88), 87, 409), (None, 87, 400), (snapshot(86), 87, 409)])
def test_changed_missing_or_older_latest_rejected_before_queue(monkeypatch, latest, expected, status):
    _, execute, redis = setup_route(monkeypatch, latest)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.run_threat_analysis(IndMoneyUsThreatRunRequest(expected_snapshot_id=expected), object(), SimpleNamespace(id=11)))
    assert error.value.status_code == status
    execute.assert_not_awaited()
    redis.aclose.assert_not_awaited()


@pytest.mark.parametrize("value", [0, -1, 1.5, "87", True])
def test_expected_identity_requires_positive_integer(value):
    with pytest.raises(ValidationError):
        IndMoneyUsThreatRunRequest(expected_snapshot_id=value)


@pytest.mark.parametrize("patch", [{"reported_holdings_count": 2}, {"parse_status": "unparsed"}, {"holdings": []}])
def test_source_guard_preserves_existing_holdings_gate(monkeypatch, patch):
    from app.shared.exceptions import ValidationException
    latest = snapshot()
    for key, value in patch.items():
        setattr(latest, key, value)
    _, execute, redis = setup_route(monkeypatch, latest)
    with pytest.raises(ValidationException):
        asyncio.run(routes.run_threat_analysis(IndMoneyUsThreatRunRequest(expected_snapshot_id=87), object(), SimpleNamespace(id=11)))
    execute.assert_not_awaited()
    redis.aclose.assert_not_awaited()
