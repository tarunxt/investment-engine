"""Durable lineage regressions for Auto-Live repository reconciliation."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy import create_engine, inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session, sessionmaker

import app.models  # noqa: F401
import app.domains.polymarket_auto_live.order_intent_service as order_intent_service
import pytest
from app.domains.auth.models import User
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderAttemptRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveCapitalReservationRecord,
    PolymarketAutoLiveRunRecord,
)
from app.domains.polymarket_auto_live.console_projection import (
    build_run_console_projection,
)
from app.domains.polymarket_auto_live.order_intent_service import (
    _active_reserved_cash,
    _automatic_attempt_budget_allows,
    _wake_waiting_buys_after_exit_success,
    _visible_run_decision_records_sync,
    create_or_refresh_run_order_intents_sync,
    list_due_order_intent_ids_sync,
    reconcile_order_intent_sync,
    summarize_run_orders_sync,
)
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
    SyncPolymarketAutoLiveRepository,
    extract_stage3_decisions_from_run,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveOrderPlan,
    BullpenAutoLiveRun,
    BullpenAutoLiveStageResult,
)
from app.infrastructure.database.base import Base


def _decision(
    *,
    title: str,
    decision_id: str = "decision-1",
    run_id: str = "run-1",
) -> BullpenAutoLiveDecision:
    return BullpenAutoLiveDecision(
        id=decision_id,
        run_id=run_id,
        created_at="2026-07-26T10:00:00+00:00",
        updated_at="2026-07-26T10:01:00+00:00",
        market_id="market-1",
        market_title=title,
        theme="Test",
        side="YES",
        decision="EXIT",
        risk_status="Ready",
        price_cents=50,
        fair_probability_pct=50,
        edge_pp=0,
        score=0,
        confidence="Medium",
        evidence_status="Moderate",
        reason="Persisted decision.",
        summary="Persisted decision.",
    )


def test_decision_relationship_does_not_orphan_delete_durable_intents() -> None:
    relationship = inspect(PolymarketAutoLiveDecisionRecord).relationships[
        "order_intents"
    ]
    foreign_key = next(iter(PolymarketAutoLiveOrderIntentRecord.__table__.c.decision_id.foreign_keys))

    assert "delete-orphan" not in relationship.cascade
    assert relationship.passive_deletes is True
    assert foreign_key.ondelete == "SET NULL"


def test_operator_intent_mutations_take_blocking_row_lock() -> None:
    statement = order_intent_service._intent_user_mutation_lock_query(
        user_id=7,
        intent_id="intent-lock",
    )
    compiled = str(
        statement.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )

    assert "FOR UPDATE" in compiled
    assert "polymarket_auto_live_order_intents.id = 'intent-lock'" in compiled
    assert "polymarket_auto_live_order_intents.user_id = 7" in compiled
    assert statement.get_execution_options()["populate_existing"] is True


def test_run_order_summary_never_returns_another_users_run(tmp_path) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'run-order-ownership.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
        ],
    )
    with Session(engine) as session:
        session.add_all(
            [
                User(
                    id=7,
                    email="run-order-requester@example.test",
                    username="run-order-requester",
                    password_hash="test-only",
                ),
                User(
                    id=8,
                    email="run-order-owner@example.test",
                    username="run-order-owner",
                    password_hash="test-only",
                ),
                PolymarketAutoLiveRunRecord(
                    id="foreign-run-orders",
                    user_id=8,
                    status="completed",
                    triggered_by="scheduler",
                    dry_run=False,
                    started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                    completed_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
                    summary="Another user's private run.",
                    payload={},
                ),
            ]
        )
        session.commit()

        with pytest.raises(ValueError, match="Saved Auto-Live run not found"):
            summarize_run_orders_sync(
                session,
                user_id=7,
                run_id="foreign-run-orders",
            )


def test_decision_reconciliation_updates_in_place_without_deleting_intent_parent() -> None:
    existing = PolymarketAutoLiveDecisionRecord(
        id="decision-1",
        user_id=7,
        run_id="run-1",
        market_id="market-1",
        market_title="Old title",
        side="YES",
        decision="EXIT",
        risk_status="Ready",
        edge_pp=0,
        score=0,
        payload={},
    )
    superseded = PolymarketAutoLiveDecisionRecord(
        id="decision-old",
        user_id=7,
        run_id="run-1",
        market_id="market-old",
        market_title="Superseded title",
        side="YES",
        decision="EXIT",
        risk_status="Ready",
        edge_pp=0,
        score=0,
        console_projection={"id": "decision-old"},
        payload={"id": "decision-old"},
    )

    class _ScalarRows:
        def scalars(self):
            return self

        def all(self):
            return [existing, superseded]

    class _Session:
        def __init__(self) -> None:
            self.added: list[object] = []

        def scalar(self, _query):
            return "run-1"

        def execute(self, _query):
            return _ScalarRows()

        def add(self, value: object) -> None:
            self.added.append(value)

    session = _Session()
    repository = SyncPolymarketAutoLiveRepository(session)  # type: ignore[arg-type]

    repository.replace_run_decisions(7, "run-1", [_decision(title="Updated title")])

    assert existing.market_title == "Updated title"
    assert existing.payload["market_title"] == "Updated title"
    assert (
        superseded.payload["_console_reconciliation_state"]
        == "superseded"
    )
    assert superseded.console_projection is None
    assert session.added == []


def test_replace_run_decisions_materializes_generator_and_forces_owner_run(
    tmp_path,
) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'decision-generator.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
        ],
    )
    with Session(engine) as session:
        session.add_all(
            [
                User(
                    id=7,
                    email="decision-owner@example.test",
                    username="decision-owner",
                    password_hash="test-only",
                ),
                User(
                    id=8,
                    email="other-owner@example.test",
                    username="other-owner",
                    password_hash="test-only",
                ),
                PolymarketAutoLiveRunRecord(
                    id="run-1",
                    user_id=7,
                    status="completed",
                    triggered_by="scheduler",
                    dry_run=True,
                    started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                    summary="Owned run.",
                    payload={},
                ),
                PolymarketAutoLiveRunRecord(
                    id="run-other-user",
                    user_id=8,
                    status="completed",
                    triggered_by="scheduler",
                    dry_run=True,
                    started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                    summary="Other user's run.",
                    payload={},
                ),
            ]
        )
        session.commit()
        repository = SyncPolymarketAutoLiveRepository(session)

        decisions = (
            decision
            for decision in [
                _decision(
                    title="Canonical owner",
                    run_id="run-other-user",
                )
            ]
        )
        repository.replace_run_decisions(7, "run-1", decisions)
        session.flush()

        record = session.get(
            PolymarketAutoLiveDecisionRecord,
            "decision-1",
        )
        assert record is not None
        assert record.run_id == "run-1"
        assert record.payload["run_id"] == "run-1"
        assert record.console_projection["run_id"] == "run-1"

        with pytest.raises(ValueError, match="run ownership mismatch"):
            repository.save_run(
                7,
                BullpenAutoLiveRun(
                    id="run-other-user",
                    triggered_by="scheduler",
                    status="completed",
                    dry_run=True,
                    started_at="2026-07-27T10:00:00+00:00",
                    completed_at="2026-07-27T10:01:00+00:00",
                    summary="Must not take over another user's run.",
                ),
            )
        assert (
            session.get(
                PolymarketAutoLiveRunRecord,
                "run-other-user",
            ).user_id
            == 8
        )

        with pytest.raises(ValueError, match="Auto-Live run not found"):
            repository.replace_run_decisions(
                7,
                "run-other-user",
                [
                    _decision(
                        title="Must not cross attach",
                        decision_id="decision-cross-user",
                        run_id="run-other-user",
                    )
                ],
            )
        assert (
            session.get(
                PolymarketAutoLiveDecisionRecord,
                "decision-cross-user",
            )
            is None
        )


def test_stage3_recovery_forces_embedded_decision_onto_owning_run() -> None:
    raw_decision = _decision(
        title="Recovered row",
        run_id="run-attacker-controlled",
    ).model_dump(mode="json")
    run = BullpenAutoLiveRun(
        id="run-owned",
        triggered_by="scheduler",
        status="completed",
        dry_run=True,
        started_at="2026-07-27T10:00:00+00:00",
        completed_at="2026-07-27T10:01:00+00:00",
        summary="Recovered.",
        stage_results=[
            BullpenAutoLiveStageResult(
                stage_number=3,
                stage_name="Stage 3",
                status="pass",
                reason="Completed.",
                outputs={
                    "workflow_stage_key": "invest",
                    "phase_status": "completed",
                    "decision_rows": [raw_decision],
                },
                started_at="2026-07-27T10:00:30+00:00",
                completed_at="2026-07-27T10:01:00+00:00",
            )
        ],
    )

    recovered = extract_stage3_decisions_from_run(run)

    assert recovered is not None
    assert [decision.run_id for decision in recovered] == ["run-owned"]


def test_stage3_recovery_prefers_exact_stage_three_over_mislabeled_internal_stage() -> None:
    canonical_decision = _decision(
        title="Canonical Stage 3 row",
        decision_id="decision-canonical-stage3",
        run_id="run-canonical-stage3",
    ).model_dump(mode="json")
    internal_decision = _decision(
        title="Internal mislabeled row",
        decision_id="decision-internal-stage7",
        run_id="run-canonical-stage3",
    ).model_dump(mode="json")
    run = BullpenAutoLiveRun(
        id="run-canonical-stage3",
        triggered_by="scheduler",
        status="completed",
        dry_run=True,
        started_at="2026-07-27T10:00:00+00:00",
        completed_at="2026-07-27T10:01:00+00:00",
        summary="Recovered from canonical Stage 3.",
        stage_results=[
            BullpenAutoLiveStageResult(
                stage_number=3,
                stage_name="Stage 3",
                status="pass",
                reason="Completed.",
                outputs={
                    "workflow_stage_key": "invest",
                    "phase_status": "completed",
                    "decision_rows": [canonical_decision],
                },
                started_at="2026-07-27T10:00:30+00:00",
                completed_at="2026-07-27T10:01:00+00:00",
            ),
            BullpenAutoLiveStageResult(
                stage_number=7,
                stage_name="Internal cleanup",
                status="pass",
                reason="Internal row.",
                outputs={
                    "workflow_stage_key": "invest",
                    "phase_status": "completed",
                    "decision_rows": [internal_decision],
                },
                started_at="2026-07-27T10:01:00+00:00",
                completed_at="2026-07-27T10:01:01+00:00",
            ),
        ],
    )

    recovered = extract_stage3_decisions_from_run(run)

    assert recovered is not None
    assert [decision.id for decision in recovered] == [
        "decision-canonical-stage3"
    ]


@pytest.mark.anyio
async def test_terminal_identity_reconciliation_reads_expected_size_plus_one():
    all_database_ids = [
        "decision-canonical",
        *[f"decision-corrupt-extra-{index}" for index in range(100)],
    ]
    observed_limits: list[int] = []
    observed_statements: list[object] = []

    class _ScalarRows:
        def __init__(self, rows):
            self.rows = rows

        def scalars(self):
            return self

        def all(self):
            return self.rows

    class _Session:
        async def execute(self, statement):
            observed_statements.append(statement)
            limit = int(statement._limit_clause.value)
            observed_limits.append(limit)
            return _ScalarRows(all_database_ids[:limit])

    decision_ids = await AsyncPolymarketAutoLiveRepository(
        _Session()  # type: ignore[arg-type]
    ).list_visible_decision_id_sets_by_run(
        7,
        {"run-corrupt-overcount": 1},
    )

    assert observed_limits == [2]
    assert decision_ids == {
        "run-corrupt-overcount": {
            "decision-canonical",
            "decision-corrupt-extra-0",
        }
    }
    order_by_sql = str(
        observed_statements[0].compile(dialect=postgresql.dialect())
    ).split("ORDER BY", maxsplit=1)[1]
    assert order_by_sql.index("created_at DESC") < order_by_sql.index(
        "updated_at DESC"
    )
    assert order_by_sql.index("updated_at DESC") < order_by_sql.index(
        ".id DESC"
    )


def test_intent_reconciliation_loader_never_resurrects_superseded_decisions(
    tmp_path,
) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'visible-decisions.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
        ],
    )

    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email="visible-decisions@example.test",
                username="visible-decisions",
                password_hash="test-only",
            )
        )
        session.add(
            PolymarketAutoLiveRunRecord(
                id="run-visible-decisions",
                user_id=7,
                status="confirming",
                triggered_by="scheduler",
                dry_run=False,
                started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                summary="Reconciling visible decisions.",
                payload={},
            )
        )
        session.add_all(
            [
                PolymarketAutoLiveDecisionRecord(
                    id="decision-visible",
                    user_id=7,
                    run_id="run-visible-decisions",
                    market_id="market-visible",
                    market_title="Visible decision",
                    side="YES",
                    decision="BUY_NEW",
                    risk_status="Ready",
                    edge_pp=5,
                    score=5,
                    payload={"id": "decision-visible"},
                ),
                PolymarketAutoLiveDecisionRecord(
                    id="decision-superseded",
                    user_id=7,
                    run_id="run-visible-decisions",
                    market_id="market-old",
                    market_title="Superseded decision",
                    side="NO",
                    decision="EXIT",
                    risk_status="Ready",
                    edge_pp=0,
                    score=0,
                    payload={
                        "id": "decision-superseded",
                        "_console_reconciliation_state": "superseded",
                    },
                ),
            ]
        )
        session.commit()

        visible = _visible_run_decision_records_sync(
            session,
            user_id=7,
            run_id="run-visible-decisions",
        )

    assert [record.id for record in visible] == ["decision-visible"]


def test_orphan_confirming_run_cannot_block_a_real_durable_workflow(tmp_path) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'active-runs.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
            PolymarketAutoLiveOrderIntentRecord.__table__,
            PolymarketAutoLiveOrderAttemptRecord.__table__,
            PolymarketAutoLiveCapitalReservationRecord.__table__,
        ],
    )

    def run_record(run_id: str, status: str, hour: int):
        return PolymarketAutoLiveRunRecord(
            id=run_id,
            user_id=7,
            status=status,
            triggered_by="scheduler",
            dry_run=False,
            started_at=datetime(2026, 7, 27, hour, tzinfo=UTC),
            summary=f"{run_id} summary",
            payload={},
        )

    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email="active-runs@example.test",
                username="active-runs",
                password_hash="test-only",
            )
        )
        session.add_all(
            [
                run_record("run-running", "running", 10),
                run_record("run-confirming-real", "confirming", 11),
                run_record("run-confirming-orphan", "confirming", 12),
            ]
        )
        intent = PolymarketAutoLiveOrderIntentRecord(
            id="intent-real",
            user_id=7,
            run_id="run-confirming-real",
            action="buy",
            market_id="market-1",
            status="WAITING_FOR_COLLATERAL",
            idempotency_key="active-run-test",
        )
        session.add(intent)
        session.commit()

        repository = SyncPolymarketAutoLiveRepository(session)
        assert repository.get_running_run_record(7).id == "run-confirming-real"

        intent.status = "DEFERRED"
        session.commit()
        assert repository.get_running_run_record(7).id == "run-running"

        running = session.get(PolymarketAutoLiveRunRecord, "run-running")
        assert running is not None
        running.status = "completed"
        session.commit()
        assert repository.get_running_run_record(7) is None


def test_retry_exhaustion_releases_db_backed_buy_reservation(tmp_path) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'reservation-release.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
            PolymarketAutoLiveOrderIntentRecord.__table__,
            PolymarketAutoLiveOrderAttemptRecord.__table__,
            PolymarketAutoLiveCapitalReservationRecord.__table__,
        ],
    )

    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email="reservation-release@example.test",
                username="reservation-release",
                password_hash="test-only",
            )
        )
        session.add(
            PolymarketAutoLiveRunRecord(
                id="run-reservation-release",
                user_id=7,
                status="confirming",
                triggered_by="scheduler",
                dry_run=False,
                started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                summary="Reservation release regression.",
                payload={},
            )
        )
        intent = PolymarketAutoLiveOrderIntentRecord(
            id="intent-reservation-release",
            user_id=7,
            run_id="run-reservation-release",
            action="buy",
            market_id="replacement-market",
            status="RETRY_WAIT",
            retryable=True,
            attempt_count=2,
            max_attempts=2,
            idempotency_key="reservation-release-idempotency",
            reserved_cash_usd=1.22,
            execution_metadata_json={"reservation_state": "active"},
        )
        session.add(intent)
        session.add(
            PolymarketAutoLiveCapitalReservationRecord(
                user_id=7,
                order_intent_id=intent.id,
                amount_usd=1.22,
                status="active",
            )
        )
        session.commit()

        assert _active_reserved_cash(session, user_id=7) == pytest.approx(1.22)
        assert (
            _automatic_attempt_budget_allows(
                intent,
                now=datetime(2026, 7, 27, 11, tzinfo=UTC),
                session=session,
            )
            is False
        )
        session.commit()

        reservation = session.query(
            PolymarketAutoLiveCapitalReservationRecord
        ).one()
        assert intent.status == "FAILED_PERMANENT"
        assert intent.reserved_cash_usd == 0
        assert intent.execution_metadata_json["reservation_state"] == "released"
        assert reservation.status == "released"
        assert reservation.amount_usd == 0
        assert _active_reserved_cash(session, user_id=7) == 0


def test_active_reserved_cash_ignores_legacy_terminal_leaks_but_keeps_ambiguous(
    tmp_path,
) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'reservation-filter.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
            PolymarketAutoLiveOrderIntentRecord.__table__,
            PolymarketAutoLiveOrderAttemptRecord.__table__,
            PolymarketAutoLiveCapitalReservationRecord.__table__,
        ],
    )

    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email="reservation-filter@example.test",
                username="reservation-filter",
                password_hash="test-only",
            )
        )
        session.add(
            PolymarketAutoLiveRunRecord(
                id="run-reservation-filter",
                user_id=7,
                status="confirming",
                triggered_by="scheduler",
                dry_run=False,
                started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                summary="Reservation filter regression.",
                payload={},
            )
        )
        intents = [
            PolymarketAutoLiveOrderIntentRecord(
                id="intent-terminal-leak",
                user_id=7,
                run_id="run-reservation-filter",
                action="buy",
                market_id="terminal-market",
                status="FAILED_PERMANENT",
                idempotency_key="terminal-leak-idempotency",
                reserved_cash_usd=9,
                execution_metadata_json={"reservation_state": "active"},
            ),
            PolymarketAutoLiveOrderIntentRecord(
                id="intent-ambiguous",
                user_id=7,
                run_id="run-reservation-filter",
                action="buy",
                market_id="ambiguous-market",
                status="CONFIRMING",
                idempotency_key="ambiguous-idempotency",
                reserved_cash_usd=2,
                execution_metadata_json={"reservation_state": "active"},
            ),
            PolymarketAutoLiveOrderIntentRecord(
                id="intent-persisted-reference",
                user_id=7,
                run_id="run-reservation-filter",
                action="buy",
                market_id="persisted-market",
                status="DEFERRED",
                remote_order_id="remote-order-1",
                idempotency_key="persisted-reference-idempotency",
                reserved_cash_usd=3,
                execution_metadata_json={"reservation_state": "active"},
            ),
            PolymarketAutoLiveOrderIntentRecord(
                id="intent-unknown-fill-rejection",
                user_id=7,
                run_id="run-reservation-filter",
                action="buy",
                market_id="rejected-market",
                status="REJECTED",
                remote_order_id="remote-rejected-order",
                idempotency_key="definitive-rejection-idempotency",
                reserved_cash_usd=4,
                execution_metadata_json={
                    "reservation_state": "active",
                    "reconciliation_fill_evidence": {
                        "version": "v1",
                        "quantity_known": False,
                        "filled_shares": None,
                        "definitive_zero_fill": False,
                    },
                },
            ),
            PolymarketAutoLiveOrderIntentRecord(
                id="intent-ambiguous-timeout",
                user_id=7,
                run_id="run-reservation-filter",
                action="buy",
                market_id="timeout-market",
                status="TIMED_OUT",
                remote_order_id="remote-timeout-order",
                idempotency_key="ambiguous-timeout-idempotency",
                reserved_cash_usd=5,
                execution_metadata_json={"reservation_state": "active"},
            ),
            PolymarketAutoLiveOrderIntentRecord(
                id="intent-cancelled-unknown-fill",
                user_id=7,
                run_id="run-reservation-filter",
                action="buy",
                market_id="cancelled-market",
                status="CANCELLED",
                remote_order_id="remote-cancelled-order",
                first_submitted_at=datetime(
                    2026,
                    7,
                    27,
                    10,
                    1,
                    tzinfo=UTC,
                ),
                idempotency_key="cancelled-unknown-fill-idempotency",
                reserved_cash_usd=6,
                execution_metadata_json={
                    "reservation_state": "active",
                    "reconciliation_fill_evidence": {
                        "version": "v1",
                        "quantity_known": False,
                        "filled_shares": None,
                        "definitive_zero_fill": False,
                    },
                },
            ),
        ]
        session.add_all(intents)
        session.add_all(
            [
                PolymarketAutoLiveCapitalReservationRecord(
                    user_id=7,
                    order_intent_id=intent.id,
                    amount_usd=amount,
                    status="active",
                )
                for intent, amount in zip(
                    intents,
                    (9, 2, 3, 4, 5, 6),
                    strict=True,
                )
            ]
        )
        session.commit()

        # CONFIRMING (2), DEFERRED-with-reference (3), unknown-fill REJECTED
        # (4), ambiguous TIMED_OUT (5), and CANCELLED with an unknown fill
        # (6) all remain fenced. Only the reference-free FAILED_PERMANENT
        # legacy leak is ignored.
        assert _active_reserved_cash(session, user_id=7) == pytest.approx(20)

        cancelled = intents[-1]
        cancelled.execution_metadata_json = {
            **dict(cancelled.execution_metadata_json or {}),
            "reconciliation_fill_evidence": {
                "version": "v1",
                "quantity_known": True,
                "filled_shares": 0.0,
                "definitive_zero_fill": True,
            },
        }
        assert order_intent_service._release_buy_reservation_if_no_remote_evidence(
            session,
            cancelled,
            reason="Remote cancellation explicitly proved zero fill.",
            definitive_no_fill=True,
        )
        session.flush()
        assert _active_reserved_cash(session, user_id=7) == pytest.approx(14)


def _buy_market_fence_engine(tmp_path, name: str):
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / f'{name}.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
            PolymarketAutoLiveOrderIntentRecord.__table__,
            PolymarketAutoLiveOrderAttemptRecord.__table__,
            PolymarketAutoLiveCapitalReservationRecord.__table__,
        ],
    )
    with Session(engine) as session:
        session.add_all(
            [
                User(
                    id=7,
                    email=f"{name}-current@example.test",
                    username=f"{name}-current",
                    password_hash="test-only",
                ),
                User(
                    id=8,
                    email=f"{name}-prior@example.test",
                    username=f"{name}-prior",
                    password_hash="test-only",
                ),
                PolymarketAutoLiveRunRecord(
                    id=f"{name}-current-run",
                    user_id=7,
                    status="running",
                    triggered_by="scheduler",
                    dry_run=False,
                    started_at=datetime(2026, 7, 27, 11, tzinfo=UTC),
                    summary="Current BUY fence run.",
                    payload={},
                ),
                PolymarketAutoLiveRunRecord(
                    id=f"{name}-prior-run",
                    user_id=8,
                    status="failed",
                    triggered_by="scheduler",
                    dry_run=False,
                    started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                    summary="Prior BUY fence run.",
                    payload={},
                ),
            ]
        )
        session.commit()
    return engine


@pytest.mark.parametrize(
    "prior_status",
    [
        "TIMED_OUT",
        "CANCELLED",
        "REJECTED",
        "DEFERRED",
        "FAILED_PERMANENT",
    ],
)
def test_singleton_market_fence_blocks_unknown_fill_terminal_buy_aliases(
    tmp_path,
    prior_status,
) -> None:
    engine = _buy_market_fence_engine(
        tmp_path,
        f"unknown-fill-{prior_status.lower()}",
    )
    with Session(engine) as session:
        prior = PolymarketAutoLiveOrderIntentRecord(
            id=f"prior-{prior_status.lower()}",
            user_id=8,
            run_id=f"unknown-fill-{prior_status.lower()}-prior-run",
            action="buy",
            market_id="legacy-provider-market-id",
            slug="legacy-provider-market-slug",
            condition_id="shared-condition-id",
            side="NO",
            status=prior_status,
            retryable=False,
            remote_order_id=f"remote-{prior_status.lower()}",
            first_submitted_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
            idempotency_key=f"prior-{prior_status.lower()}-idempotency",
            execution_metadata_json={
                "reconciliation_fill_evidence": {
                    "version": "v1",
                    "quantity_known": False,
                    "filled_shares": None,
                    "definitive_zero_fill": False,
                }
            },
        )
        current = PolymarketAutoLiveOrderIntentRecord(
            id=f"current-{prior_status.lower()}",
            user_id=7,
            run_id=f"unknown-fill-{prior_status.lower()}-current-run",
            action="buy",
            market_id="current-provider-market-id",
            slug="current-provider-market-slug",
            condition_id="shared-condition-id",
            side="YES",
            requested_order_usd=1,
            current_order_usd=1,
            status="READY",
            retryable=True,
            idempotency_key=f"current-{prior_status.lower()}-idempotency",
            execution_metadata_json={},
        )
        session.add_all([prior, current])
        session.commit()

        assert not order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T09:00:00+00:00"
            ),
        )
        proof = current.execution_metadata_json[
            "buy_market_exposure_preflight"
        ]
        assert proof["scope"] == "singleton_bullpen_runtime"
        assert proof["market_wide"] is True
        assert proof["result"] == "blocked"
        assert proof["conflict_count"] == 1
        assert proof["conflicts"][0]["intent_id"] == prior.id
        assert proof["conflicts"][0]["matched_aliases"] == [
            "shared-condition-id"
        ]
        assert proof["conflicts"][0]["definitive_zero_fill"] is False


@pytest.mark.parametrize("prior_status", ["CANCELLED", "REJECTED"])
def test_singleton_market_fence_allows_explicit_definitive_zero_fill(
    tmp_path,
    prior_status,
) -> None:
    engine = _buy_market_fence_engine(
        tmp_path,
        f"zero-fill-{prior_status.lower()}",
    )
    with Session(engine) as session:
        prior = PolymarketAutoLiveOrderIntentRecord(
            id=f"prior-zero-{prior_status.lower()}",
            user_id=8,
            run_id=f"zero-fill-{prior_status.lower()}-prior-run",
            action="buy",
            market_id="shared-market-id",
            side="NO",
            status=prior_status,
            retryable=False,
            remote_order_id=f"remote-zero-{prior_status.lower()}",
            first_submitted_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
            idempotency_key=f"prior-zero-{prior_status.lower()}-idempotency",
            execution_metadata_json={
                "reconciliation_fill_evidence": {
                    "version": "v1",
                    "quantity_known": True,
                    "filled_shares": 0.0,
                    "definitive_zero_fill": True,
                }
            },
        )
        current = PolymarketAutoLiveOrderIntentRecord(
            id=f"current-zero-{prior_status.lower()}",
            user_id=7,
            run_id=f"zero-fill-{prior_status.lower()}-current-run",
            action="buy",
            market_id="shared-market-id",
            side="YES",
            requested_order_usd=1,
            current_order_usd=1,
            status="READY",
            retryable=True,
            idempotency_key=f"current-zero-{prior_status.lower()}-idempotency",
            execution_metadata_json={},
        )
        session.add_all([prior, current])
        session.commit()

        assert order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T09:00:00+00:00"
            ),
        )
        assert current.execution_metadata_json[
            "buy_market_exposure_preflight"
        ]["result"] == "pass"
        assert current.reserved_cash_usd == pytest.approx(1)


def test_singleton_market_fence_allows_only_first_same_market_reservation(
    tmp_path,
) -> None:
    engine = _buy_market_fence_engine(
        tmp_path,
        "same-market-reservation",
    )
    with Session(engine) as session:
        first = PolymarketAutoLiveOrderIntentRecord(
            id="same-market-first",
            user_id=7,
            run_id="same-market-reservation-current-run",
            action="buy",
            market_id="same-market",
            side="YES",
            requested_order_usd=1,
            current_order_usd=1,
            status="READY",
            retryable=True,
            idempotency_key="same-market-first-idempotency",
            execution_metadata_json={},
        )
        second = PolymarketAutoLiveOrderIntentRecord(
            id="same-market-second",
            user_id=8,
            run_id="same-market-reservation-prior-run",
            action="buy",
            market_id="same-market",
            side="NO",
            requested_order_usd=1,
            current_order_usd=1,
            status="READY",
            retryable=True,
            idempotency_key="same-market-second-idempotency",
            execution_metadata_json={},
        )
        session.add_all([first, second])
        session.commit()

        assert order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=first.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T09:00:00+00:00"
            ),
        )
        assert not order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=second.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T09:00:00+00:00"
            ),
        )
        assert second.execution_metadata_json[
            "buy_market_exposure_preflight"
        ]["conflicts"][0]["intent_id"] == first.id


def test_singleton_cash_fence_counts_consumed_buy_newer_than_balance(
    tmp_path,
) -> None:
    engine = _buy_market_fence_engine(
        tmp_path,
        "consumed-buy-balance-race",
    )
    with Session(engine) as session:
        filled = PolymarketAutoLiveOrderIntentRecord(
            id="consumed-prior-buy",
            user_id=8,
            run_id="consumed-prior-run",
            action="buy",
            market_id="different-prior-market",
            side="YES",
            status="FILLED",
            retryable=False,
            requested_order_usd=9,
            current_order_usd=9,
            confirmed_at=datetime(2026, 7, 27, 10, 5, tzinfo=UTC),
            terminal_at=datetime(2026, 7, 27, 10, 5, tzinfo=UTC),
            idempotency_key="consumed-prior-idempotency",
            execution_metadata_json={"reservation_state": "consumed"},
        )
        current = PolymarketAutoLiveOrderIntentRecord(
            id="different-current-buy",
            user_id=7,
            run_id="different-current-run",
            action="buy",
            market_id="different-current-market",
            side="NO",
            requested_order_usd=1,
            current_order_usd=1,
            status="READY",
            retryable=True,
            idempotency_key="different-current-idempotency",
            execution_metadata_json={},
        )
        session.add_all([filled, current])
        session.add(
            PolymarketAutoLiveCapitalReservationRecord(
                user_id=8,
                order_intent_id=filled.id,
                amount_usd=9,
                status="consumed",
            )
        )
        session.commit()

        assert not order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T10:04:00+00:00"
            ),
        )

        assert order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T10:06:00+00:00"
            ),
        )


def test_singleton_cash_preflight_is_mirrored_before_reservation(
    tmp_path,
) -> None:
    engine = _buy_market_fence_engine(
        tmp_path,
        "cash-preflight-mirror",
    )
    with Session(engine) as session:
        current = PolymarketAutoLiveOrderIntentRecord(
            id="cash-proof-current-buy",
            user_id=7,
            run_id="cash-proof-current-run",
            action="buy",
            market_id="cash-proof-market",
            side="YES",
            requested_order_usd=1.22,
            current_order_usd=1.22,
            status="READY",
            retryable=True,
            attempt_count=1,
            idempotency_key="cash-proof-current-idempotency",
            execution_metadata_json={},
        )
        attempt = PolymarketAutoLiveOrderAttemptRecord(
            intent_id=current.id,
            attempt_number=1,
            started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
            result_status="STARTED",
            sanitized_request_json={},
            sanitized_response_json={},
            reconciliation_json={},
        )
        session.add_all([current, attempt])
        session.commit()

        assert order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=3.44,
            order_usd=1.22,
            available_balance_checked_at=(
                "2026-07-27T10:00:00+00:00"
            ),
        )

        proof = current.execution_metadata_json[
            "buy_cash_reservation_preflight"
        ]
        assert proof["version"] == "v2"
        assert proof["scope"] == "singleton_bullpen_runtime"
        assert proof["balance_checked_at"] == (
            "2026-07-27T10:00:00+00:00"
        )
        assert proof["balance_buffer_usd"] == 1
        assert proof["held_reservation_usd"] == 0
        assert proof["requested_order_usd"] == 1.22
        assert proof["result"] == "pass"
        assert (
            attempt.sanitized_request_json[
                "_stage3_buy_cash_reservation_preflight"
            ]
            == proof
        )


def test_singleton_market_fence_blocks_fill_newer_than_wallet_preflight(
    tmp_path,
) -> None:
    engine = _buy_market_fence_engine(
        tmp_path,
        "fill-after-wallet-preflight",
    )
    with Session(engine) as session:
        filled = PolymarketAutoLiveOrderIntentRecord(
            id="newly-filled-prior-buy",
            user_id=8,
            run_id="fill-after-wallet-preflight-prior-run",
            action="buy",
            market_id="same-racing-market",
            side="NO",
            status="FILLED",
            retryable=False,
            remote_order_id="newly-filled-remote",
            first_submitted_at=datetime(2026, 7, 27, 10, 3, tzinfo=UTC),
            last_submitted_at=datetime(2026, 7, 27, 10, 3, tzinfo=UTC),
            confirmed_at=datetime(2026, 7, 27, 10, 5, tzinfo=UTC),
            terminal_at=datetime(2026, 7, 27, 10, 5, tzinfo=UTC),
            idempotency_key="newly-filled-prior-idempotency",
            execution_metadata_json={"reservation_state": "consumed"},
        )
        current = PolymarketAutoLiveOrderIntentRecord(
            id="wallet-preflight-current-buy",
            user_id=7,
            run_id="fill-after-wallet-preflight-current-run",
            action="buy",
            market_id="same-racing-market",
            side="YES",
            requested_order_usd=1,
            current_order_usd=1,
            status="READY",
            retryable=True,
            idempotency_key="wallet-preflight-current-idempotency",
            execution_metadata_json={
                "wallet_snapshot_lineage": {
                    "fetched_at": "2026-07-27T10:04:00+00:00",
                }
            },
        )
        session.add_all([filled, current])
        session.commit()

        assert not order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T10:04:00+00:00"
            ),
        )
        assert current.execution_metadata_json[
            "buy_market_exposure_preflight"
        ]["conflicts"][0]["status"] == "FILLED"

        current.execution_metadata_json = {
            **dict(current.execution_metadata_json),
            "wallet_snapshot_lineage": {
                "fetched_at": "2026-07-27T10:06:00+00:00",
            },
        }
        session.commit()

        assert order_intent_service._reserve_buy_if_possible(
            session,
            intent_id=current.id,
            available_balance_usd=10,
            order_usd=1,
            available_balance_checked_at=(
                "2026-07-27T10:06:00+00:00"
            ),
        )


@pytest.mark.parametrize(
    (
        "reconciled_status",
        "reconciled_filled_shares",
        "expected_reservation_status",
    ),
    [
        ("REJECTED", 0.0, "released"),
        ("CANCELLED", 0.0, "released"),
        ("CANCELLED", None, "active"),
        ("TIMED_OUT", None, "active"),
    ],
)
def test_reconciled_definitive_no_fill_releases_submitted_buy_cash(
    tmp_path,
    monkeypatch,
    reconciled_status,
    reconciled_filled_shares,
    expected_reservation_status,
) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / f'reconciled-{reconciled_status.lower()}.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
            PolymarketAutoLiveOrderIntentRecord.__table__,
            PolymarketAutoLiveOrderAttemptRecord.__table__,
            PolymarketAutoLiveCapitalReservationRecord.__table__,
        ],
    )
    run = BullpenAutoLiveRun(
        id=f"run-reconciled-{reconciled_status.lower()}",
        triggered_by="scheduler",
        status="confirming",
        dry_run=False,
        started_at="2026-07-27T10:00:00+00:00",
        summary="Reconciling a submitted buy.",
    )
    intent_id = f"intent-reconciled-{reconciled_status.lower()}"
    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email=f"reconciled-{reconciled_status.lower()}@example.test",
                username=f"reconciled-{reconciled_status.lower()}",
                password_hash="test-only",
            )
        )
        session.add(
            PolymarketAutoLiveRunRecord(
                id=run.id,
                user_id=7,
                status="confirming",
                triggered_by="scheduler",
                dry_run=False,
                started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                summary=run.summary,
                payload=run.model_dump(mode="json"),
            )
        )
        session.add(
            PolymarketAutoLiveOrderIntentRecord(
                id=intent_id,
                user_id=7,
                run_id=run.id,
                action="buy",
                market_id="submitted-buy-market",
                slug="submitted-buy-market",
                side="YES",
                requested_order_usd=1.22,
                current_order_usd=1.22,
                requested_shares=2,
                current_shares=2,
                requested_limit_price_cents=61,
                current_limit_price_cents=61,
                status="CONFIRMING",
                retryable=True,
                attempt_count=1,
                max_attempts=4,
                remote_order_id="remote-submitted-buy",
                first_submitted_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
                last_submitted_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
                idempotency_key=f"reconciled-{reconciled_status.lower()}",
                reserved_cash_usd=1.22,
                execution_metadata_json={"reservation_state": "active"},
                version=1,
            )
        )
        session.add(
            PolymarketAutoLiveOrderAttemptRecord(
                intent_id=intent_id,
                attempt_number=1,
                started_at=datetime(2026, 7, 27, 10, 1, tzinfo=UTC),
                result_status="CONFIRMING",
                sanitized_response_json={"status": "open"},
            )
        )
        session.add(
            PolymarketAutoLiveCapitalReservationRecord(
                user_id=7,
                order_intent_id=intent_id,
                amount_usd=1.22,
                status="active",
            )
        )
        session.commit()

    async def fake_reconcile(_intent):
        operator_block = (
            {
                "version": "v1",
                "blocked_at": "2026-07-27T10:16:00+00:00",
                "age_seconds": 900,
                "max_age_seconds": 900,
                "last_error_code": "AMBIGUOUS_SUBMISSION",
                "automatic_resubmission": False,
                "support_verification_required": True,
            }
            if reconciled_status == "TIMED_OUT"
            else None
        )
        return order_intent_service.IntentSubmissionResult(
            status=reconciled_status,
            detail=(
                "BUY_RECONCILIATION_OPERATOR_BLOCKED: Bullpen support "
                "verification is required."
                if operator_block is not None
                else f"Bullpen reconciled the buy as {reconciled_status}."
            ),
            retryable=False,
            filled_shares=reconciled_filled_shares,
            remaining_shares=2,
            last_error_code=(
                "AMBIGUOUS_SUBMISSION"
                if operator_block is not None
                else None
            ),
            raw_response=(
                {"buy_reconciliation_operator_block": operator_block}
                if operator_block is not None
                else None
            ),
        )

    session_factory = sessionmaker(bind=engine, future=True)
    monkeypatch.setattr(
        order_intent_service,
        "SyncSessionLocal",
        session_factory,
    )
    monkeypatch.setattr(
        order_intent_service,
        "_reconcile_intent_async",
        fake_reconcile,
    )
    monkeypatch.setattr(
        order_intent_service,
        "sync_run_and_decisions_from_intents_sync",
        lambda session, **_kwargs: session.get(
            PolymarketAutoLiveRunRecord,
            run.id,
        ),
    )

    assert reconcile_order_intent_sync(intent_id) == reconciled_status

    with Session(engine) as session:
        intent = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        reservation = session.query(
            PolymarketAutoLiveCapitalReservationRecord
        ).one()
        assert intent is not None
        assert intent.status == reconciled_status
        assert reservation.status == expected_reservation_status
        fill_evidence = intent.execution_metadata_json[
            "reconciliation_fill_evidence"
        ]
        assert fill_evidence["quantity_known"] is (
            reconciled_filled_shares is not None
        )
        assert fill_evidence["definitive_zero_fill"] is (
            reconciled_status in {"REJECTED", "CANCELLED"}
            and reconciled_filled_shares == 0
        )
        if reconciled_status == "TIMED_OUT":
            assert (
                intent.execution_metadata_json[
                    "buy_reconciliation_operator_block"
                ]["max_age_seconds"]
                == 900
            )
            assert (
                intent.execution_metadata_json[
                    "automatic_resubmission"
                ]
                is False
            )
        if expected_reservation_status == "released":
            assert intent.reserved_cash_usd == 0
            assert reservation.amount_usd == 0
        else:
            assert intent.reserved_cash_usd == pytest.approx(1.22)
            assert reservation.amount_usd == pytest.approx(1.22)
            assert _active_reserved_cash(
                session,
                user_id=7,
            ) == pytest.approx(1.22)


def test_pre_minimum_cash_replacement_persists_waiting_and_wakes_after_exit(
    tmp_path,
) -> None:
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'replacement-waiting.sqlite'}",
        future=True,
    )
    Base.metadata.create_all(
        engine,
        tables=[
            User.__table__,
            PolymarketAutoLiveRunRecord.__table__,
            PolymarketAutoLiveDecisionRecord.__table__,
            PolymarketAutoLiveOrderIntentRecord.__table__,
            PolymarketAutoLiveOrderAttemptRecord.__table__,
            PolymarketAutoLiveCapitalReservationRecord.__table__,
        ],
    )
    dependency_group = (
        "stage3-replacement:run-replacement-waiting:exit-market"
    )
    exit_plan = BullpenAutoLiveOrderPlan(
        id="order-exit",
        action="sell",
        side="YES",
        status="planned",
        stage3_status="EXIT_NOT_SUBMITTED",
        market_id="exit-market",
        market_title="Exit market",
        dependency_group=dependency_group,
        order_size_usd=0,
        shares=2,
        limit_price_cents=50,
        max_slippage_cents=2,
        dry_run=False,
        detail="Exit first.",
        created_at="2026-07-27T10:00:00+00:00",
    )
    buy_plan = BullpenAutoLiveOrderPlan(
        id="order-replacement-buy",
        action="buy",
        side="NO",
        status="planned",
        stage3_status="REPLACEMENT_SLOT_RESERVED",
        market_id="replacement-market",
        market_title="Replacement market",
        dependency_group=dependency_group,
        order_size_usd=1,
        shares=0,
        limit_price_cents=40,
        max_slippage_cents=2,
        dry_run=False,
        detail=(
            "Placeholder only; pre-exit cash is below the minimum and final "
            "sizing waits for fresh exit proceeds."
        ),
        created_at="2026-07-27T10:00:00+00:00",
    )
    exit_decision = _decision(title="Exit market").model_copy(
        update={
            "id": "decision-exit",
            "run_id": "run-replacement-waiting",
            "market_id": "exit-market",
            "market_title": "Exit market",
            "slug": "exit-market",
            "decision": "EXIT",
            "order_plan": exit_plan,
        }
    )
    buy_decision = _decision(title="Replacement market").model_copy(
        update={
            "id": "decision-replacement-buy",
            "run_id": "run-replacement-waiting",
            "market_id": "replacement-market",
            "market_title": "Replacement market",
            "slug": "replacement-market",
            "decision": "BUY_NEW",
            "order_plan": buy_plan,
        }
    )
    run = BullpenAutoLiveRun(
        id="run-replacement-waiting",
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-27T10:00:00+00:00",
        summary="Pre-exit cash is $0.50; replacement waits for exit proceeds.",
        audit_metadata={
            "settings_snapshot": {
                "min_order_usd": 1,
                "max_order_usd": 25,
            },
            "pre_exit_cash_in_hand_usd": 0.5,
        },
    )

    with Session(engine) as session:
        session.add(
            User(
                id=7,
                email="replacement-waiting@example.test",
                username="replacement-waiting",
                password_hash="test-only",
            )
        )
        session.add(
            PolymarketAutoLiveRunRecord(
                id=run.id,
                user_id=7,
                status="running",
                triggered_by="scheduler",
                dry_run=False,
                started_at=datetime(2026, 7, 27, 10, tzinfo=UTC),
                summary=run.summary,
                payload=run.model_dump(mode="json"),
            )
        )
        session.commit()

        intents = create_or_refresh_run_order_intents_sync(
            session,
            user_id=7,
            run=run,
            decisions=[exit_decision, buy_decision],
        )
        session.commit()
        by_id = {intent.id: intent for intent in intents}
        waiting = by_id["order-replacement-buy"]
        assert by_id["order-exit"].dependency_group == dependency_group
        assert waiting.dependency_group == dependency_group
        assert waiting.status == "WAITING_FOR_EXIT"
        assert waiting.next_attempt_at is None
        assert waiting.reserved_cash_usd == 0
        assert waiting.execution_metadata_json["post_exit_sizing_policy"][
            "enabled"
        ] is True
        for _dispatcher_pass in range(3):
            assert list_due_order_intent_ids_sync(
                session,
                run_id=run.id,
            ) == ["order-exit"]
        persisted_waiting = session.get(
            PolymarketAutoLiveOrderIntentRecord,
            "order-replacement-buy",
        )
        assert persisted_waiting is not None
        assert persisted_waiting.status == "WAITING_FOR_EXIT"
        assert persisted_waiting.attempt_count == 0

        exit_record = session.get(
            PolymarketAutoLiveOrderIntentRecord,
            "order-exit",
        )
        assert exit_record is not None
        exit_record.status = "FILLED"
        exit_record.confirmed_at = datetime(2026, 7, 27, 10, 5, tzinfo=UTC)
        awakened = _wake_waiting_buys_after_exit_success(
            session,
            exit_record=exit_record,
            confirmed_at=exit_record.confirmed_at,
        )
        session.commit()

        replacement = session.get(
            PolymarketAutoLiveOrderIntentRecord,
            "order-replacement-buy",
        )
        assert awakened == ["order-replacement-buy"]
        assert replacement is not None
        assert replacement.status == "READY"
        assert replacement.dependency_metadata_json["exit_intent_id"] == "order-exit"
        assert replacement.dependency_metadata_json["exit_confirmed_at"]
        assert list_due_order_intent_ids_sync(
            session,
            run_id=run.id,
            now=datetime(2026, 7, 27, 10, 6, tzinfo=UTC),
        ) == ["order-replacement-buy"]

        # Defense in depth for a historical lost-wake state: even if the exit
        # committed before a WAITING_FOR_EXIT row became visible to the wake
        # scan, the bounded watchdog rechecks the committed terminal sibling.
        replacement.status = "WAITING_FOR_EXIT"
        replacement.next_attempt_at = None
        replacement.last_error_code = "SETTLEMENT_PENDING"
        replacement.dependency_metadata_json = {
            **dict(replacement.dependency_metadata_json or {}),
            "state": "waiting_for_exit",
        }
        # Simulate a row persisted by the legacy planner that placed the
        # dependency group only on the BUY.  The watchdog must repair the EXIT
        # and recover the lost wake without an operator rewrite.
        exit_record.dependency_group = None
        session.commit()

        recovered = (
            order_intent_service.watchdog_requeue_stale_order_intents_sync(
                session,
                now=datetime(2026, 7, 27, 10, 7, tzinfo=UTC),
            )
        )
        session.commit()
        session.refresh(replacement)

        assert recovered == ["order-replacement-buy"]
        assert replacement.status == "READY"
        assert replacement.last_error_code == "DEPENDENCY_WAKE_RECOVERED"
        assert replacement.dependency_metadata_json["wake_recovered_at"]
        session.refresh(exit_record)
        assert exit_record.dependency_group == dependency_group


@pytest.mark.anyio
async def test_verified_portfolio_legacy_lookup_selects_only_one_projection() -> None:
    class _EmptyResult:
        def one_or_none(self):
            return None

    class _Session:
        query = None

        async def execute(self, query):
            self.query = query
            return _EmptyResult()

    session = _Session()
    repository = AsyncPolymarketAutoLiveRepository(session)  # type: ignore[arg-type]

    assert await repository.get_latest_verified_portfolio_snapshot(7) is None
    assert session.query is not None
    compiled = str(
        session.query.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )

    assert "LIMIT 1" in compiled
    assert "active_positions_found" in compiled
    assert "wallet_snapshot_status" in compiled
    assert "wallet_refresh_error" in compiled
    assert "wallet_market_enrichment_error" in compiled
    assert "btrim" in compiled.lower()
    assert "polymarket_auto_live_runs.payload" not in compiled


@pytest.mark.anyio
async def test_verified_portfolio_legacy_lookup_falls_through_newer_failed_empty_snapshot() -> None:
    positions = [
        {
            "position_key": f"market-{index}::NO",
            "market_id": f"market-{index}",
            "market_title": f"Market {index}",
            "side": "NO",
            "shares": 1,
            "classification": "active",
        }
        for index in range(7)
    ]
    stage = BullpenAutoLiveStageResult(
        stage_number=1,
        stage_name="Stage 1",
        status="pass",
        reason="Wallet scan completed.",
        outputs={
            "workflow_stage_key": "scan",
            "phase_status": "completed",
            "wallet_snapshot_status": "fresh",
            "wallet_snapshot_freshness_state": "fresh",
            "active_positions_found": positions,
            "console_trade_active_positions": 7,
            "console_trade_occupied_positions": 7,
            "console_trade_max_positions": 10,
        },
        started_at="2026-07-27T10:00:00+00:00",
        completed_at="2026-07-27T10:00:01+00:00",
    )
    prior_run = BullpenAutoLiveRun(
        id="prior-seven",
        triggered_by="scheduler",
        status="completed",
        dry_run=False,
        started_at="2026-07-27T10:00:00+00:00",
        completed_at="2026-07-27T10:00:01+00:00",
        summary="Completed.",
        stage_results=[stage],
    )
    prior_projection = build_run_console_projection(prior_run)
    newer_failed_projection = build_run_console_projection(
        prior_run.model_copy(
            update={"id": "newer-failed"},
            deep=True,
        )
    )
    newer_outputs = newer_failed_projection["stage_results"][0]["outputs"]
    newer_outputs["active_positions_found"] = []
    newer_outputs["wallet_refresh_error"] = "wallet refresh failed"

    row = SimpleNamespace(
        id=prior_run.id,
        status=prior_run.status,
        triggered_by=prior_run.triggered_by,
        dry_run=prior_run.dry_run,
        started_at=datetime(2026, 7, 27, 10, 0, tzinfo=UTC),
        completed_at=datetime(2026, 7, 27, 10, 0, 1, tzinfo=UTC),
        live_execution_requested=False,
        live_execution_attempted=False,
        decisions_count=0,
        orders_planned=0,
        orders_submitted=0,
        summary=prior_run.summary,
        error_message=None,
        console_projection=prior_projection,
        updated_at=datetime(2026, 7, 27, 10, 0, 1, tzinfo=UTC),
    )

    class _Result:
        def one_or_none(self):
            return row

    class _Session:
        async def execute(self, query):
            compiled = str(
                query.compile(
                    dialect=postgresql.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
            )
            assert "wallet_refresh_error" in compiled
            assert "wallet_market_enrichment_error" in compiled
            assert newer_outputs["wallet_refresh_error"]
            return _Result()

    repository = AsyncPolymarketAutoLiveRepository(_Session())  # type: ignore[arg-type]

    snapshot = await repository.get_latest_verified_portfolio_snapshot(7)

    assert snapshot is not None
    assert snapshot.run_id == "prior-seven"
    assert snapshot.active_positions_total == 7
    assert snapshot.occupied_positions == 7
