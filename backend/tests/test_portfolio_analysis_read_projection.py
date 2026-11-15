from __future__ import annotations

import importlib
import re
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import postgresql

import app.models  # noqa: F401 - register mapped relationship targets
from app.shared.types import JobStatus


@pytest.fixture
def anyio_backend():
    return "asyncio"


class CapturedJobSession:
    """Expose only selected columns so serialization cannot silently lazy-load."""

    def __init__(self):
        self.statements = []
        self.columns = set()
        now = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
        self.job = {
            "id": 91,
            "user_id": 17,
            "prompt": (
                "Saved portfolio analysis\n"
                "[INDMONEY_EVENT_SNAPSHOT_ID=7]\n[INDMONEY_THREAT_SNAPSHOT_ID=7]\n"
                "[EVENT_SNAPSHOT_DATE=2026-10-02]\n[THREAT_SNAPSHOT_DATE=2026-10-02]\n"
                "[EVENT_CAPTURED_AT=2026-10-02T12:00:00+00:00]\n"
                "[THREAT_CAPTURED_AT=2026-10-02T12:00:00+00:00]"
            ),
            "status": JobStatus.COMPLETED,
            "provider": "openai",
            "model": "test-model",
            "response": None,
            "runtime_metadata_json": {"stage": "completed"},
            "tokens_in": 120,
            "tokens_out": 80,
            "estimated_cost": 0.02,
            "error_message": None,
            "auto_rebalance_portfolio": "india",
            "auto_rebalance_sequence": 12,
            "auto_rebalance_label": "India Run 12",
            "created_at": now,
            "updated_at": now,
        }

    async def execute(self, statement):
        compiled = statement.compile(dialect=postgresql.dialect())
        self.statements.append(compiled)
        select_clause = str(compiled).split("\nFROM", 1)[0]
        self.columns = set(re.findall(r"jobs\.([a-z_]+)", select_clause))
        row = SimpleNamespace(**{key: self.job.get(key) for key in self.columns})
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: [row]))


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["zerodha", "indmoney_us"])
@pytest.mark.parametrize("kind", ["events", "threats"])
async def test_history_reads_only_metadata_and_preserves_serialized_response(provider, kind):
    module = importlib.import_module(f"app.domains.{provider}.{kind}_router")
    db = CapturedJobSession()
    route = module.get_events_history if kind == "events" else module.get_threat_history
    serializer = (
        module._serialize_events_history_item
        if kind == "events"
        else module._serialize_threat_history_item
    )
    expected = serializer(SimpleNamespace(**db.job))
    result = await route(limit=37, db=db, current_user=SimpleNamespace(id=17))

    assert result.history == [expected]
    assert result.history[0].snapshot_date.isoformat() == "2026-10-02"
    assert result.history[0].captured_at == db.job["created_at"]
    assert len(db.statements) == 1
    assert db.columns.isdisjoint({
        "response", "runtime_metadata_json", "request_context_json",
        "web_search_queries", "web_sources", "tokens_in", "tokens_out",
    })
    assert {"id", "prompt", "provider", "model", "status", "estimated_cost",
            "error_message", "created_at", "updated_at"} <= db.columns
    if kind == "threats":
        assert {"auto_rebalance_portfolio", "auto_rebalance_sequence",
                "auto_rebalance_label"} <= db.columns
    query = str(db.statements[0])
    assert "jobs.user_id =" in query
    assert "jobs.prompt ILIKE" in query
    assert "ORDER BY jobs.id DESC" in query
    assert "LIMIT" in query
    assert 17 in db.statements[0].params.values()
    assert 37 in db.statements[0].params.values()


@pytest.mark.anyio
@pytest.mark.parametrize("provider", ["zerodha", "indmoney_us"])
@pytest.mark.parametrize("kind", ["events", "threats"])
async def test_latest_keeps_detail_fields_without_unrelated_job_payloads(provider, kind):
    module = importlib.import_module(f"app.domains.{provider}.{kind}_router")
    db = CapturedJobSession()
    if kind == "events":
        result = await module.get_latest_events_analysis(
            db=db, current_user=SimpleNamespace(id=17),
        )
    else:
        result = await module.get_latest_threat_analysis(
            include_history=False, db=db, current_user=SimpleNamespace(id=17),
        )
    assert result.analysis.job_id == 91
    assert result.analysis.tokens_in == 120
    assert result.analysis.tokens_out == 80
    if provider == "indmoney_us":
        assert result.analysis.snapshot_id == 7
    assert {"response", "tokens_in", "tokens_out"} <= db.columns
    if kind == "threats":
        assert result.analysis.runtime_metadata_json == {"stage": "completed"}
    else:
        assert "runtime_metadata_json" not in db.columns
    assert db.columns.isdisjoint({
        "request_context_json", "web_search_queries", "web_sources",
        "export_error", "exported_sheet_url",
    })
    assert len(db.statements) == 1
