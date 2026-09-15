"""Workflow ownership regressions for Bullpen History reads."""

from datetime import UTC, datetime

import app.models  # noqa: F401
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.domains.auth.models import User
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.repository import (
    _history_workspace_filter,
    apply_run_to_record,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveRun
from app.infrastructure.database.base import Base


def test_history_workspace_filter_isolates_sports_and_legacy_007_runs(tmp_path) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'history-workspaces.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[User.__table__, PolymarketAutoLiveRunRecord.__table__],
    )

    def run_record(
        run_id: str,
        workspace_profile: str | None,
    ) -> PolymarketAutoLiveRunRecord:
        return PolymarketAutoLiveRunRecord(
            id=run_id,
            user_id=7,
            status="completed",
            triggered_by="manual",
            workspace_profile=workspace_profile,
            dry_run=True,
            started_at=datetime(2026, 9, 15, 10, tzinfo=UTC),
            completed_at=datetime(2026, 9, 15, 10, 1, tzinfo=UTC),
            summary=f"{run_id} summary",
            payload={},
        )

    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email="history-workspaces@example.test",
                username="history-workspaces",
                password_hash="test-only",
            )
        )
        session.add_all(
            [
                run_record("legacy-007", None),
                run_record("explicit-007", "bullpen007"),
                run_record("sports", "bullpen-sports"),
            ]
        )
        session.commit()

        record = PolymarketAutoLiveRunRecord
        sports_ids = session.scalars(
            select(record.id).where(
                record.user_id == 7,
                _history_workspace_filter(record, "bullpen-sports"),
            )
        ).all()
        bullpen007_ids = session.scalars(
            select(record.id).where(
                record.user_id == 7,
                _history_workspace_filter(record, "bullpen007"),
            )
        ).all()

    assert sports_ids == ["sports"]
    assert set(bullpen007_ids) == {"legacy-007", "explicit-007"}


def test_run_persistence_captures_workspace_profile_without_reading_payload() -> None:
    source = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "app/domains/polymarket_auto_live/repository.py"
    ).read_text()

    assert "record.workspace_profile = (" in source
    assert "run.request_context.console_profile.workspace_profile" in source
    assert "or record.workspace_profile" in source


def test_terminal_save_preserves_workspace_after_request_context_is_cleared() -> None:
    record = PolymarketAutoLiveRunRecord(
        id="sports-terminal",
        user_id=7,
        status="running",
        triggered_by="manual",
        workspace_profile="bullpen-sports",
        dry_run=True,
        started_at=datetime(2026, 9, 15, 10, tzinfo=UTC),
        summary="Running.",
        payload={},
    )
    run = BullpenAutoLiveRun(
        id="sports-terminal",
        triggered_by="manual",
        status="completed",
        dry_run=True,
        started_at="2026-09-15T10:00:00+00:00",
        completed_at="2026-09-15T10:05:00+00:00",
        summary="Completed.",
        request_context=None,
    )

    apply_run_to_record(record, run, user_id=7)

    assert record.workspace_profile == "bullpen-sports"
