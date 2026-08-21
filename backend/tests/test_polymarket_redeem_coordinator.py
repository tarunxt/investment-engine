import asyncio
from datetime import UTC, datetime, timedelta
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import redeem_coordinator
from app.domains.polymarket.bullpen import BullpenCommandError
from app.domains.polymarket.models import PolymarketRedeemAttemptRecord
from app.infrastructure.database.base import Base


def _session_factory(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'redeem-attempts.sqlite'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(
        engine, tables=[PolymarketRedeemAttemptRecord.__table__]
    )
    return sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


def _wallet_position(
    *,
    condition_id: str,
    classification: str = "positive_payout_claimable",
    is_claimable: bool = True,
    expected_payout_usdc: float | None = 3.5,
    shares: float = 4,
):
    return SimpleNamespace(
        condition_id=condition_id,
        market_id=f"market-{condition_id}",
        slug=f"slug-{condition_id}",
        market_title=f"Market {condition_id}",
        shares=shares,
        classification=classification,
        expected_payout_usdc=expected_payout_usdc,
        is_claimable=is_claimable,
    )


class _RecordingExecutor:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.redeem_calls: list[list[str]] = []
        self.redeem_fallback_calls: list[bool] = []

    async def redeem(
        self,
        *,
        dry_run: bool,
        condition_ids: list[str] | None = None,
        on_chain_fallback: bool = False,
    ):
        self.redeem_calls.append(list(condition_ids or []))
        self.redeem_fallback_calls.append(on_chain_fallback)
        if self.error is not None:
            raise self.error
        return "redeem submitted"


@pytest.mark.anyio
async def test_scoped_redeem_excludes_zero_payout_residue_without_submission(tmp_path):
    session_factory = _session_factory(tmp_path)
    executor = _RecordingExecutor()

    async def fake_read_wallet_positions():
        return [
            _wallet_position(
                condition_id="condition-zero",
                classification="resolved_zero_payout",
                is_claimable=False,
                expected_payout_usdc=0,
            )
        ]

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        result = await coordinator.submit(
            condition_ids=["condition-zero"],
            source="test",
        )
        session.commit()

    assert executor.redeem_calls == []
    assert result.submitted_condition_ids == []
    assert result.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT


@pytest.mark.anyio
async def test_scoped_redeem_requires_explicit_condition_ids(tmp_path):
    session_factory = _session_factory(tmp_path)
    executor = _RecordingExecutor()

    async def fake_read_wallet_positions():
        return [_wallet_position(condition_id="condition-1")]

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        result = await coordinator.submit(
            condition_ids=["market-condition-1"],
            source="test",
        )
        session.commit()

    assert executor.redeem_calls == []
    assert result.submitted_condition_ids == []
    assert result.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_ALREADY_REDEEMED


@pytest.mark.anyio
async def test_scoped_redeem_reconciles_no_redeemable_balance_before_retrying(tmp_path):
    session_factory = _session_factory(tmp_path)
    executor = _RecordingExecutor(
        error=BullpenCommandError("Bullpen reported no redeemable balance.")
    )
    wallet_snapshots = [
        [_wallet_position(condition_id="condition-1")],
        [],
    ]

    async def fake_read_wallet_positions():
        return wallet_snapshots.pop(0) if wallet_snapshots else []

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        result = await coordinator.submit(
            condition_ids=["condition-1"],
            source="test",
        )
        session.commit()

    assert executor.redeem_calls == [["condition-1"]]
    assert result.submitted_condition_ids == []
    assert result.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_ALREADY_REDEEMED


@pytest.mark.anyio
async def test_scoped_redeem_reconciles_ambiguous_submission_before_retry(tmp_path):
    session_factory = _session_factory(tmp_path)
    executor = _RecordingExecutor()
    wallet_snapshots = [
        [_wallet_position(condition_id="condition-1")],
        [_wallet_position(condition_id="condition-1")],
        [_wallet_position(condition_id="condition-1")],
    ]

    async def fake_read_wallet_positions():
        return wallet_snapshots.pop(0) if wallet_snapshots else []

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        first_result = await coordinator.submit(
            condition_ids=["condition-1"],
            source="test",
        )
        second_result = await coordinator.submit(
            condition_ids=["condition-1"],
            source="test",
        )
        session.commit()

    assert executor.redeem_calls == [["condition-1"]]
    assert first_result.submitted_condition_ids == ["condition-1"]
    assert first_result.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_PENDING
    assert second_result.submitted_condition_ids == []
    assert second_result.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_PENDING


@pytest.mark.anyio
async def test_scoped_redeem_retries_pending_claim_after_cooldown(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("POLYMARKET_REDEEM_RETRY_COOLDOWN_SECONDS", "60")
    session_factory = _session_factory(tmp_path)
    executor = _RecordingExecutor()

    async def fake_read_wallet_positions():
        return [_wallet_position(condition_id="condition-1")]

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        first_result = await coordinator.submit(
            condition_ids=["condition-1"],
            source="test",
        )
        session.commit()

    with session_factory() as session:
        record = session.query(PolymarketRedeemAttemptRecord).one()
        record.last_submitted_at = datetime.now(UTC) - timedelta(minutes=10)
        session.commit()

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        second_result = await coordinator.submit(
            condition_ids=["condition-1"],
            source="test",
        )
        session.commit()

    assert first_result.submitted_condition_ids == ["condition-1"]
    assert second_result.submitted_condition_ids == ["condition-1"]
    assert executor.redeem_calls == [["condition-1"], ["condition-1"]]
    assert executor.redeem_fallback_calls == [False, True]
    assert second_result.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_PENDING
    assert "error_code=REDEEM_STILL_CLAIMABLE" in second_result.outcomes[0].detail


@pytest.mark.anyio
async def test_scoped_redeem_surfaces_resolution_steps_on_failure(tmp_path):
    session_factory = _session_factory(tmp_path)
    executor = _RecordingExecutor(
        error=BullpenCommandError("Bullpen relayer reports degraded service.")
    )

    async def fake_read_wallet_positions():
        return [_wallet_position(condition_id="condition-1")]

    with session_factory() as session:
        coordinator = redeem_coordinator.SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=7,
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
        with pytest.raises(BullpenCommandError) as exc_info:
            await coordinator.submit(
                condition_ids=["condition-1"],
                source="test",
            )

    assert "error_code=REDEEM_CLAIM_FAILED" in str(exc_info.value)
    assert "Resolution steps:" in str(exc_info.value)
    assert "--on-chain-fallback" in str(exc_info.value)


@pytest.mark.anyio
async def test_concurrent_scoped_redeem_submits_only_once(tmp_path, monkeypatch):
    session_factory = _session_factory(tmp_path)
    monkeypatch.setattr(redeem_coordinator, "SyncSessionLocal", session_factory)

    class BlockingExecutor:
        def __init__(self) -> None:
            self.redeem_calls: list[list[str]] = []
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def redeem(
            self,
            *,
            dry_run: bool,
            condition_ids: list[str] | None = None,
            on_chain_fallback: bool = False,
        ):
            self.redeem_calls.append(list(condition_ids or []))
            self.entered.set()
            await self.release.wait()
            return "redeem submitted"

    executor = BlockingExecutor()

    async def fake_read_wallet_positions():
        return [_wallet_position(condition_id="condition-1")]

    first = asyncio.create_task(
        redeem_coordinator.submit_scoped_redeem(
            user_id=7,
            condition_ids=["condition-1", "condition-1"],
            source="test",
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        )
    )
    await asyncio.wait_for(executor.entered.wait(), timeout=2)

    second = await asyncio.wait_for(
        redeem_coordinator.submit_scoped_redeem(
            user_id=7,
            condition_ids=["condition-1"],
            source="test",
            executor=executor,
            read_wallet_positions=fake_read_wallet_positions,
        ),
        timeout=2,
    )

    executor.release.set()
    first_result = await asyncio.wait_for(first, timeout=2)

    assert executor.redeem_calls == [["condition-1"]]
    assert second.submitted_condition_ids == []
    assert second.outcomes[0].status == redeem_coordinator.REDEEM_ATTEMPT_PENDING
    assert first_result.submitted_condition_ids == ["condition-1"]
