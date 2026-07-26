import gzip
import json
from datetime import UTC, datetime

from app.domains.bullpen_run_audit.schemas import (
    BullpenRunAuditListResponse,
    BullpenRunAuditSummaryItem,
)
from app.domains.polymarket_auto_live.bot import _summarize_run_for_list
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveRun
from app.domains.portfolio_events.schemas import PortfolioAnalysisHistoryItemResponse
from app.domains.runs.router import (
    MAX_FULL_RUN_LIST_RESPONSE_BYTES,
    _full_run_list_size_bytes,
)
from app.domains.runs.schemas import RunListItem, RunResponse
from app.shared.types import JobStatus


def _json_bytes(value: object) -> bytes:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    elif isinstance(value, list):
        value = [
            item.model_dump(mode="json") if hasattr(item, "model_dump") else item
            for item in value
        ]
    return json.dumps(value, separators=(",", ":")).encode()


def test_runs_summary_fixture_is_below_150kb():
    now = datetime.now(UTC)
    items = [
        RunListItem(
            id=index,
            prompt_preview=("Measured prompt preview " * 12)[:280],
            status=JobStatus.COMPLETED,
            current_stage=3,
            run_jobs=[],
            created_at=now,
            updated_at=now,
        )
        for index in range(100)
    ]
    payload = _json_bytes(
        {
            "items": [item.model_dump(mode="json") for item in items],
            "total": 100,
            "page": 1,
            "limit": 100,
            "pages": 1,
        }
    )

    assert len(payload) < 150_000
    assert len(gzip.compress(payload)) < len(payload)
    assert b'"prompt":' not in payload


def test_full_run_lists_fail_the_budget_instead_of_returning_megabytes():
    now = datetime.now(UTC)
    oversized = RunResponse(
        id=1,
        prompt="p" * (MAX_FULL_RUN_LIST_RESPONSE_BYTES + 10_000),
        status=JobStatus.COMPLETED,
        current_stage=3,
        run_jobs=[],
        created_at=now,
        updated_at=now,
    )

    assert _full_run_list_size_bytes([oversized]) > MAX_FULL_RUN_LIST_RESPONSE_BYTES


def test_auto_live_list_projection_removes_heavy_detail_and_stays_bounded():
    heavy = BullpenAutoLiveRun(
        id="fixture-run",
        triggered_by="scheduler",
        status="completed",
        dry_run=True,
        started_at="2026-07-26T00:00:00Z",
        completed_at="2026-07-26T00:01:00Z",
        summary="s" * 10_000,
        audit_metadata={"raw": "a" * 200_000},
        decision_ids=[f"d-{index}" for index in range(1_000)],
        order_intent_ids=[f"o-{index}" for index in range(1_000)],
    )
    summaries = [
        _summarize_run_for_list(
            heavy.model_copy(update={"id": f"fixture-run-{index}"})
        )
        for index in range(50)
    ]
    payload = _json_bytes(summaries)

    assert len(payload) < 150_000
    assert all(not run.audit_metadata for run in summaries)
    assert all(not run.decision_ids for run in summaries)
    assert all(len(run.summary) <= 500 for run in summaries)


def test_threat_and_event_history_fixture_is_below_100kb():
    now = datetime.now(UTC)
    rows = [
        PortfolioAnalysisHistoryItemResponse(
            job_id=index,
            status=JobStatus.COMPLETED,
            provider="fixture-provider",
            model="fixture-model",
            snapshot_date=now.date(),
            captured_at=now,
            created_at=now,
            updated_at=now,
            auto_rebalance_label=("Measured label " * 5)[:100],
        )
        for index in range(100)
    ]
    payload = _json_bytes({"history": [row.model_dump(mode="json") for row in rows]})

    assert len(payload) < 100_000
    assert b"raw_markdown" not in payload
    assert b'"prompt":' not in payload


def test_bullpen_audit_list_fixture_excludes_audit_blobs_and_stays_below_150kb():
    items = [
        BullpenRunAuditSummaryItem(
            run_id=f"run-{index}",
            snapshot_id=index,
            snapshot_version=1,
            run_status="completed",
            triggered_by="scheduler",
            dry_run=True,
            live_execution_requested=False,
            live_execution_attempted=False,
            started_at="2026-07-26T00:00:00Z",
            source_kind="native",
            lifecycle_status="frozen",
            audit_status="complete",
            completeness_pct=100,
        )
        for index in range(100)
    ]
    payload = _json_bytes(
        BullpenRunAuditListResponse(
            items=items,
            page=1,
            limit=100,
            total=100,
            total_pages=1,
        )
    )

    assert len(payload) < 150_000
    assert b"canonical_bundle" not in payload
    assert b"blob" not in payload
