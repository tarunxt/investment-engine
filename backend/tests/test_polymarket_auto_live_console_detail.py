import os
from datetime import UTC, datetime
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.dialects import postgresql

from app.domains.auth.dependencies import get_current_user
from app.domains.polymarket_auto_live.bot import (
    CONSOLE_RUN_DETAIL_DECISION_LIMIT,
    CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT,
    BullpenAutoLiveBot,
)
from app.domains.polymarket_auto_live.console_projection import (
    build_decision_console_projection,
    build_run_console_projection,
)
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
)
from app.domains.polymarket_auto_live.router import router as auto_live_router
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveConsoleRunDetail,
    BullpenAutoLiveRun,
)


def _run(
    *,
    run_id: str = "run-exact",
    decisions_count: int = 40,
) -> BullpenAutoLiveRun:
    return BullpenAutoLiveRun(
        id=run_id,
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-27T10:00:00+00:00",
        summary="Stage 2 is running.",
        decisions_count=decisions_count,
    )


def _decision(*, run_id: str = "run-exact") -> BullpenAutoLiveDecision:
    return BullpenAutoLiveDecision(
        id="decision-current",
        run_id=run_id,
        created_at="2026-07-27T10:00:30+00:00",
        updated_at="2026-07-27T10:00:45+00:00",
        market_id="market-current",
        market_title="Current generation",
        theme="Test",
        side="YES",
        decision="HOLD",
        risk_status="Ready",
        price_cents=50,
        fair_probability_pct=50,
        edge_pp=0,
        score=0,
        confidence="Medium",
        evidence_status="Moderate",
        reason="Coherent snapshot.",
        summary="Coherent snapshot.",
    )


@pytest.mark.anyio
async def test_repository_console_detail_is_one_statement_snapshot_during_replacement():
    """A concurrent replacement cannot split run, decision, and ID generations."""

    run = _run(decisions_count=1)
    decision = _decision(run_id=run.id)
    observed_statements: list[object] = []
    row = SimpleNamespace(
        id=run.id,
        status=run.status,
        triggered_by=run.triggered_by,
        dry_run=run.dry_run,
        started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
        completed_at=None,
        live_execution_requested=run.live_execution_requested,
        live_execution_attempted=run.live_execution_attempted,
        decisions_count=1,
        orders_planned=0,
        orders_submitted=0,
        summary=run.summary,
        error_message=None,
        console_projection=build_run_console_projection(run),
        updated_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
        decision_record_id=decision.id,
        decision_record_run_id=run.id,
        decision_record_market_id=decision.market_id,
        decision_record_slug=decision.slug,
        decision_record_market_title=decision.market_title,
        decision_record_side=decision.side,
        decision_record_action=decision.decision,
        decision_record_risk_status=decision.risk_status,
        decision_record_edge_pp=decision.edge_pp,
        decision_record_score=decision.score,
        decision_record_console_projection=build_decision_console_projection(
            decision
        ),
        decision_record_created_at=datetime(
            2026,
            7,
            27,
            10,
            0,
            30,
            tzinfo=UTC,
        ),
        decision_record_updated_at=datetime(
            2026,
            7,
            27,
            10,
            0,
            45,
            tzinfo=UTC,
        ),
    )

    class _Rows:
        def all(self):
            return [row]

    class _ConcurrentReplacementSession:
        async def execute(self, statement):
            observed_statements.append(statement)
            if len(observed_statements) > 1:
                raise AssertionError(
                    "a second SELECT could observe a replacement generation"
                )
            return _Rows()

    snapshot = await AsyncPolymarketAutoLiveRepository(
        _ConcurrentReplacementSession()  # type: ignore[arg-type]
    ).get_console_run_snapshot_for_user(
        7,
        run.id,
        decision_limit=32,
        visible_id_limit=201,
    )

    assert snapshot is not None
    observed_run, _, _, decisions, decision_ids = snapshot
    assert observed_run.id == run.id
    assert [item.id for item in decisions] == [decision.id]
    assert decision_ids == [decision.id]
    assert len(observed_statements) == 1
    order_by_sql = str(
        observed_statements[0].compile(dialect=postgresql.dialect())
    ).split("ORDER BY", maxsplit=1)[1]
    assert order_by_sql.index("created_at DESC") < order_by_sql.index(
        "updated_at DESC"
    )
    assert order_by_sql.index("updated_at DESC") < order_by_sql.index(
        ".id DESC"
    )


@pytest.mark.anyio
async def test_bounded_projection_and_visible_id_reads_break_timestamp_ties_by_id():
    observed_statements: list[object] = []

    class _EmptyRows:
        def scalars(self):
            return self

        def all(self):
            return []

    class _Session:
        async def execute(self, statement):
            observed_statements.append(statement)
            return _EmptyRows()

    repository = AsyncPolymarketAutoLiveRepository(
        _Session()  # type: ignore[arg-type]
    )
    assert (
        await repository.list_projected_decisions_for_run(
            7,
            "run-tied-timestamps",
            limit=32,
        )
        == []
    )
    assert (
        await repository.list_visible_decision_ids_for_run(
            7,
            "run-tied-timestamps",
            limit=201,
        )
        == []
    )

    assert len(observed_statements) == 2
    for statement in observed_statements:
        order_by_sql = str(
            statement.compile(dialect=postgresql.dialect())
        ).split("ORDER BY", maxsplit=1)[1]
        assert order_by_sql.index("created_at DESC") < order_by_sql.index(
            "updated_at DESC"
        )
        assert order_by_sql.index("updated_at DESC") < order_by_sql.index(
            ".id DESC"
        )


@pytest.mark.anyio
async def test_console_run_detail_reads_only_exact_user_owned_projections(
    monkeypatch,
):
    observed_calls: list[tuple[object, ...]] = []
    run = _run()

    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FakeRepository:
        def __init__(self, _session) -> None:
            pass

        async def get_console_run_snapshot_for_user(
            self,
            user_id: int,
            run_id: str,
            *,
            decision_limit: int,
            visible_id_limit: int,
        ):
            observed_calls.append(
                (
                    "coherent-snapshot",
                    user_id,
                    run_id,
                    decision_limit,
                    visible_id_limit,
                )
            )
            return (
                run,
                True,
                "2026-07-27T10:01:00+00:00",
                [],
                [f"decision-{index}" for index in range(40)],
            )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncSessionLocal",
        _FakeSession,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncPolymarketAutoLiveRepository",
        _FakeRepository,
    )

    detail = await BullpenAutoLiveBot(user_id=7).get_console_run_detail(run.id)

    assert detail.run.id == run.id
    assert detail.as_of == "2026-07-27T10:01:00+00:00"
    assert detail.projection_available is True
    assert detail.decisions_limit == CONSOLE_RUN_DETAIL_DECISION_LIMIT == 32
    assert detail.decisions_truncated is True
    assert len(detail.visible_decision_ids) == 40
    assert detail.visible_decision_ids_truncated is False
    assert observed_calls == [
        (
            "coherent-snapshot",
            7,
            run.id,
            CONSOLE_RUN_DETAIL_DECISION_LIMIT,
            CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT + 1,
        ),
    ]


@pytest.mark.anyio
async def test_console_run_detail_stops_before_decisions_when_run_is_not_owned(
    monkeypatch,
):
    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class _FakeRepository:
        def __init__(self, _session) -> None:
            pass

        async def get_console_run_snapshot_for_user(
            self,
            user_id: int,
            run_id: str,
            *,
            decision_limit: int,
            visible_id_limit: int,
        ):
            assert (user_id, run_id) == (7, "not-owned")
            assert decision_limit == CONSOLE_RUN_DETAIL_DECISION_LIMIT
            assert (
                visible_id_limit
                == CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT + 1
            )
            return None

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncSessionLocal",
        _FakeSession,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncPolymarketAutoLiveRepository",
        _FakeRepository,
    )

    with pytest.raises(ValueError, match="Auto-Live run not found"):
        await BullpenAutoLiveBot(user_id=7).get_console_run_detail("not-owned")


@pytest.mark.anyio
async def test_console_run_detail_route_is_additive_bounded_and_uncached(
    monkeypatch,
):
    app = FastAPI()
    app.include_router(auto_live_router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=7)
    run = _run(decisions_count=0)

    class _FakeBot:
        async def get_console_run_detail(
            self,
            run_id: str,
        ) -> BullpenAutoLiveConsoleRunDetail:
            if run_id != run.id:
                raise ValueError("Auto-Live run not found.")
            return BullpenAutoLiveConsoleRunDetail(
                run=run,
                decisions=[],
                generated_at="2026-07-27T10:01:01+00:00",
                as_of="2026-07-27T10:01:00+00:00",
                projection_version=1,
            )

    async def _fake_get_bot(user_id: int):
        assert user_id == 7
        return _FakeBot()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.polymarket_auto_live_bot_manager.get_bot",
        _fake_get_bot,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        found = await client.get(f"/polymarket/auto-live/runs/{run.id}/console")
        missing = await client.get(
            "/polymarket/auto-live/runs/not-owned/console",
        )

    assert found.status_code == 200
    assert found.json()["run"]["id"] == run.id
    assert found.json()["decisions_limit"] == 32
    assert found.headers["cache-control"] == "private, no-cache"
    assert found.headers["vary"] == "Authorization, Cookie"
    assert "app;dur=" in found.headers["server-timing"]
    assert missing.status_code == 404
