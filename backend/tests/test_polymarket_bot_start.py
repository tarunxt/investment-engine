import asyncio
import os
import time
from collections import defaultdict
from datetime import datetime, timezone

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.bullpen import (
    BullpenBalanceReader,
    BullpenCommandError,
    BullpenLiveExecutor,
    buy_max_price_for_execution,
    extract_bullpen_insufficient_collateral_amount,
    is_claim_command_unavailable_warning,
    is_redeem_metadata_lookup_warning,
    sell_min_price_for_execution,
)
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.logger import PolymarketFileLogger
from app.domains.polymarket.schemas import (
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
)
from app.domains.polymarket.storage import JsonModelStore
from app.domains.polymarket.providers import (
    normalize_fallback_trader_row,
    trader_matches_leaderboard_period,
)


def test_auto_redeem_live_defaults_on(monkeypatch):
    monkeypatch.delenv("AUTO_REDEEM_LIVE", raising=False)

    assert load_polymarket_config().auto_redeem_live is True


def test_auto_redeem_live_can_be_disabled(monkeypatch):
    monkeypatch.setenv("AUTO_REDEEM_LIVE", "false")

    assert load_polymarket_config().auto_redeem_live is False


def test_leaderboard_period_filter_rejects_stale_daily_and_weekly_rows():
    now = datetime(2026, 6, 14, tzinfo=timezone.utc)
    stale = normalize_fallback_trader_row(
        {
            "address": "0x56687BF447DB6fFA42FFE2204a05EDAA20f55839",
            "username": "Theo4",
            "profit": 22_053_933.75,
            "lastTradeAt": "2024-11-13T09:16:00Z",
        }
    )
    assert stale is not None

    assert trader_matches_leaderboard_period(stale, "today", now=now) is False
    assert trader_matches_leaderboard_period(stale, "weekly", now=now) is False


def test_leaderboard_period_filter_keeps_current_and_unknown_timestamp_rows():
    now = datetime(2026, 6, 14, 12, tzinfo=timezone.utc)
    current = normalize_fallback_trader_row(
        {
            "address": "0x6A72f61820b26b1fe4d956E17B6DC2A1Ea3033EE",
            "username": "kch123",
            "profit": 11_550_170.62,
            "lastTradeAt": "2026-06-14T04:22:00Z",
        }
    )
    unknown = normalize_fallback_trader_row(
        {
            "address": "0x78B9ac44a6D7D7A076c14e0AD518b301b63c6B76",
            "username": "Len9311238",
            "profit": 8_709_972.99,
        }
    )
    assert current is not None
    assert unknown is not None

    assert trader_matches_leaderboard_period(current, "today", now=now) is True
    assert trader_matches_leaderboard_period(current, "weekly", now=now) is True
    assert trader_matches_leaderboard_period(unknown, "today", now=now) is True


class SlowProvider:
    async def get_top_traders(self):
        await asyncio.sleep(30)
        return []

    async def get_recent_trades(self, traders):
        return []


@pytest.mark.anyio
async def test_start_returns_before_initial_poll_finishes(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": False,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = SlowProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=BullpenLiveExecutor(),
        balance_reader=BullpenBalanceReader(),
        logger=logger,
    )

    started_at = time.perf_counter()
    await bot.start()
    elapsed = time.perf_counter() - started_at

    assert elapsed < 0.5
    assert bot.running is True
    assert bot._poll_task is not None

    bot._poll_task.cancel()
    await asyncio.gather(bot._poll_task, return_exceptions=True)


class SlowDoctorExecutor:
    async def doctor(self):
        await asyncio.sleep(30)
        raise AssertionError("doctor must run in the background after init returns")


class SlowBalanceReader:
    async def refresh(self):
        await asyncio.sleep(30)
        raise AssertionError("balance must run in the background after init returns")


@pytest.mark.anyio
async def test_get_state_returns_while_startup_balance_is_refreshing(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": False,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = SlowProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=SlowDoctorExecutor(),
        balance_reader=SlowBalanceReader(),
        logger=logger,
    )

    await bot.init()
    await asyncio.sleep(0)

    state = await asyncio.wait_for(bot.get_state(), timeout=0.5)

    assert state.live.balance.status in {"idle", "loading"}

    await bot.shutdown()


@pytest.mark.anyio
async def test_init_returns_before_startup_warmup_finishes(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": False,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = SlowProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=SlowDoctorExecutor(),
        balance_reader=SlowBalanceReader(),
        logger=logger,
    )

    started_at = time.perf_counter()
    await bot.init()
    elapsed = time.perf_counter() - started_at

    assert elapsed < 0.5
    assert bot._startup_warmup_task is not None
    assert bot._balance_task is not None

    await bot.shutdown()


class EmptyProvider:
    async def get_top_traders(self):
        return []

    async def get_recent_trades(self, traders):
        return []


class StaticDoctorExecutor:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0

    async def doctor(self):
        self.calls += 1
        return self.statuses.pop(0)


class IdleBalanceReader:
    async def refresh(self):
        raise AssertionError("balance refresh is not part of bot startup")


async def build_live_bot(tmp_path, live_executor):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": True,
            "use_live_reads": True,
            "live_unlock_mode": "automatic",
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = EmptyProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    return PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=live_executor,
        balance_reader=IdleBalanceReader(),
        logger=logger,
    )


@pytest.mark.anyio
async def test_live_start_refreshes_doctor_even_when_recent_failure_exists(tmp_path):
    from app.domains.polymarket.schemas import PolymarketDoctorStatus

    executor = StaticDoctorExecutor(
        [
            PolymarketDoctorStatus(
                checked_at="2026-06-11T10:00:00+00:00",
                ok=True,
                message="Bullpen status and preflight checks passed.",
            )
        ]
    )
    bot = await build_live_bot(tmp_path, executor)
    bot.doctor_status = PolymarketDoctorStatus(
        checked_at="2026-06-11T09:59:00+00:00",
        ok=False,
        message="Previous Bullpen doctor failure.",
    )

    await bot.start()

    assert executor.calls == 1
    assert bot.running is True
    assert bot.live_unlocked is True
    assert bot.active_mode == "live-trading"

    bot._poll_task.cancel()
    await asyncio.gather(bot._poll_task, return_exceptions=True)


@pytest.mark.anyio
async def test_live_start_falls_back_to_read_only_when_doctor_fails(tmp_path):
    from app.domains.polymarket.schemas import PolymarketDoctorStatus

    executor = StaticDoctorExecutor(
        [
            PolymarketDoctorStatus(
                checked_at="2026-06-11T10:00:00+00:00",
                ok=False,
                message="Bullpen doctor failed after status passed: preflight: login required",
            )
        ]
    )
    bot = await build_live_bot(tmp_path, executor)

    await bot.start()

    assert executor.calls == 1
    assert bot.running is True
    assert bot.live_unlocked is False
    assert bot.active_mode == "live-read"
    assert bot.live_source_status.source_mode == "live-read"
    assert any(
        "Live trading remains locked; starting read-only poller instead"
        in activity.message
        and "Last doctor result: Bullpen doctor failed after status passed"
        in activity.message
        for activity in bot.recent_activity
    )

    bot._poll_task.cancel()
    await asyncio.gather(bot._poll_task, return_exceptions=True)


class ActivityProvider:
    async def get_top_traders(self):
        from app.domains.polymarket.schemas import PolymarketTrader

        return [
            PolymarketTrader(
                id="0x204f72f35326db932158CBA6AdF0B9A1DA95e14",
                name="swisstony",
                address="0x204f72f35326db932158CBA6AdF0B9A1DA95e14",
                activity_source="fallback",
                volume_24h=883_184_386.32,
                trades_1h=0,
                trades_6h=0,
                trades_24h=0,
                source_reason="Fallback tracked wallet; no recent trade detected yet",
                source="live-read",
            )
        ]

    async def get_recent_trades(self, traders):
        from app.domains.polymarket.schemas import PolymarketSourceTrade

        return [
            PolymarketSourceTrade(
                id="trade-1",
                source_trade_key="live-read:swisstony:trade-1",
                trader_id=traders[0].id,
                trader_name="swisstony",
                trader_address=traders[0].address,
                clean_trader_identity=traders[0].address,
                market_id="tennis-match",
                market_title="Tennis Match",
                outcome="Player A",
                side="BUY",
                price=0.63,
                size_usd=399.23,
                timestamp="2026-06-12T10:00:00+00:00",
                source="live-read",
            )
        ]


@pytest.mark.anyio
async def test_poll_refreshes_tracked_trader_activity_columns(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.domains.polymarket.providers.datetime",
        type(
            "FixedDateTime",
            (datetime,),
            {
                "now": classmethod(
                    lambda cls, tz=None: datetime(2026, 6, 12, 10, 5, tzinfo=tz)
                )
            },
        ),
    )
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": True,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = ActivityProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=BullpenLiveExecutor(),
        balance_reader=BullpenBalanceReader(),
        logger=logger,
    )
    bot.running = True

    await bot._poll_unlocked()

    trader = bot.tracked_traders[0]
    assert trader.trades_1h == 1
    assert trader.trades_6h == 1
    assert trader.trades_24h == 1
    assert trader.last_trade_at == "2026-06-12T10:00:00+00:00"
    assert trader.last_trade_age == "5m ago"
    assert trader.source_reason == "Recent trade activity detected from tracked wallet"


@pytest.mark.anyio
async def test_live_read_provider_reads_fallback_wallet_activity(monkeypatch):
    from app.domains.polymarket.providers import BullpenReadOnlyProvider
    from app.domains.polymarket.schemas import PolymarketTrader

    config = load_polymarket_config().model_copy(update={"manual_tracked_wallets": ""})
    provider = BullpenReadOnlyProvider(config)
    calls = []

    async def fake_wallet_activity(address):
        calls.append(address)
        return [
            {
                "id": "wallet-trade-1",
                "address": address,
                "market_id": "tennis-match",
                "market_title": "Tennis Match",
                "outcome": "Player A",
                "side": "BUY",
                "price": 0.63,
                "size_usd": 399.23,
                "timestamp": "2026-06-12T10:00:00+00:00",
            }
        ]

    monkeypatch.setattr(provider, "_read_wallet_activity", fake_wallet_activity)
    trades = await provider.get_recent_trades(
        [
            PolymarketTrader(
                id="0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea",
                name="RN1",
                address="0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea",
                activity_source="fallback",
                source_reason="Fallback tracked wallet; no recent trade detected yet",
                source="live-read",
            )
        ]
    )

    assert calls == ["0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea"]
    assert len(trades) == 1
    assert trades[0].trader_name == "RN1"
    assert trades[0].trader_address == "0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea"


def test_normalize_trade_row_accepts_polymarket_data_api_usdc_size():
    from app.domains.polymarket.providers import normalize_trade_row

    normalized = normalize_trade_row(
        {
            "proxyWallet": "0x56687BF447DB6FFA42FFE2204A05EDAA20F55839",
            "timestamp": 1781268000,
            "conditionId": "0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917",
            "type": "TRADE",
            "size": 1079.0,
            "usdcSize": 399.23,
            "transactionHash": "0xabc123",
            "price": 0.37,
            "side": "BUY",
            "title": "Lyon: Daniel Galan vs Kimmer Coppejans",
            "slug": "lyon-daniel-galan-vs-kimmer-coppejans",
            "outcome": "Daniel Galan",
            "name": "RN1",
            "pseudonym": "RN1",
        }
    )

    assert normalized["accepted"] is True
    assert (
        normalized["trade"]["address"] == "0x56687BF447DB6FFA42FFE2204A05EDAA20F55839"
    )
    assert normalized["trade"]["market_id"] == "lyon-daniel-galan-vs-kimmer-coppejans"
    assert normalized["trade"]["size_usd"] == 399.23
    assert normalized["trade"]["price"] == 0.37


@pytest.mark.anyio
async def test_wallet_activity_queries_resolved_public_profile_proxy_wallet(
    monkeypatch,
):
    from app.domains.polymarket.providers import BullpenReadOnlyProvider

    config = load_polymarket_config().model_copy(update={"manual_tracked_wallets": ""})
    provider = BullpenReadOnlyProvider(config)
    original = "0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea"
    proxy = "0x56687BF447DB6FFA42FFE2204A05EDAA20F55839"
    calls = []

    async def fake_bullpen_json(*args, **kwargs):
        return []

    async def fake_profile_addresses(address):
        assert address == original
        return [proxy]

    async def fake_data_api_wallet_activity(wallet):
        calls.append(wallet)
        if wallet == original:
            return []
        return [
            {
                "id": "proxy-trade-1",
                "address": wallet,
                "market_id": "tennis-match",
                "market_title": "Tennis Match",
                "outcome": "Player A",
                "side": "BUY",
                "price": 0.63,
                "size_usd": 399.23,
                "timestamp": "2026-06-12T10:00:00+00:00",
            }
        ]

    monkeypatch.setattr(
        "app.domains.polymarket.providers.run_first_bullpen_json", fake_bullpen_json
    )
    monkeypatch.setattr(
        provider, "_read_public_profile_wallet_addresses", fake_profile_addresses
    )
    monkeypatch.setattr(
        provider, "_read_data_api_wallet_activity", fake_data_api_wallet_activity
    )

    trades = await provider._read_wallet_activity(original)

    assert calls == [original, proxy]
    assert len(trades) == 1
    assert trades[0]["address"] == proxy


def test_normalize_trade_row_estimates_usd_from_shares_and_price():
    from app.domains.polymarket.providers import normalize_trade_row

    normalized = normalize_trade_row(
        {
            "proxyWallet": "0x56687BF447DB6FFA42FFE2204A05EDAA20F55839",
            "timestamp": 1781268000,
            "conditionId": "0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917",
            "size": 10,
            "transactionHash": "0xabc123",
            "price": 0.37,
            "side": "BUY",
            "title": "Lyon: Daniel Galan vs Kimmer Coppejans",
            "slug": "lyon-daniel-galan-vs-kimmer-coppejans",
            "outcome": "Daniel Galan",
            "name": "RN1",
        }
    )

    assert normalized["accepted"] is True
    assert normalized["trade"]["size_usd"] == 3.7


@pytest.mark.anyio
async def test_wallet_activity_falls_back_to_public_data_api_when_bullpen_empty(
    monkeypatch,
):
    from app.domains.polymarket.providers import BullpenReadOnlyProvider

    config = load_polymarket_config().model_copy(update={"manual_tracked_wallets": ""})
    provider = BullpenReadOnlyProvider(config)
    address = "0x56687BF447DB6FFA42FFE2204A05EDAA20F55839"
    calls = []

    async def fake_bullpen_json(*args, **kwargs):
        return []

    async def fake_data_api_wallet_activity(wallet):
        calls.append(wallet)
        return [
            {
                "id": "0xabc123",
                "address": wallet,
                "market_id": "tennis-match",
                "market_title": "Tennis Match",
                "outcome": "Player A",
                "side": "BUY",
                "price": 0.63,
                "size_usd": 399.23,
                "timestamp": "2026-06-12T10:00:00+00:00",
            }
        ]

    monkeypatch.setattr(
        "app.domains.polymarket.providers.run_first_bullpen_json", fake_bullpen_json
    )
    monkeypatch.setattr(
        provider, "_read_data_api_wallet_activity", fake_data_api_wallet_activity
    )

    trades = await provider._read_wallet_activity(address)

    assert calls == [address]
    assert trades[0]["id"] == "0xabc123"
    assert trades[0]["size_usd"] == 399.23


def test_select_tracked_traders_keeps_manual_and_fills_with_leaderboard():
    from app.domains.polymarket.providers import select_tracked_traders
    from app.domains.polymarket.schemas import PolymarketTrader

    manual = [
        PolymarketTrader(
            id="manual",
            name="Manual",
            address="0x1000000000000000000000000000000000000000",
            source_reason="Manual tracked account",
            source="live-read",
        )
    ]
    leaderboard = [
        PolymarketTrader(
            id=f"leader-{index}",
            name=f"Leader {index}",
            address=f"0x{index + 2:040x}",
            trades_24h=10 - index,
            volume_24h=1000 - index,
            source_reason="Weekly profit leaderboard trader discovered via Bullpen",
            source="live-read",
        )
        for index in range(3)
    ]

    selected = select_tracked_traders([*leaderboard, *manual], manual, 3)

    assert [trader.name for trader in selected] == ["Manual", "Leader 0", "Leader 1"]


@pytest.mark.anyio
async def test_deleted_leaderboard_tracked_account_stays_hidden(tmp_path):
    from app.domains.polymarket.schemas import PolymarketTrader

    bot = await build_live_bot(tmp_path, StaticDoctorExecutor([]))
    trader = PolymarketTrader(
        id="0x3000000000000000000000000000000000000000",
        name="Deleted Leader",
        address="0x3000000000000000000000000000000000000000",
        source_reason="Today profit leaderboard trader discovered via Bullpen",
        source="live-read",
    )

    await bot._sync_leaderboard_tracked_accounts_unlocked([trader])
    account_id = bot.tracked_accounts[-1].id
    await bot.delete_tracked_account(account_id)
    await bot._sync_leaderboard_tracked_accounts_unlocked([trader])
    state = await bot.get_state()

    assert all(account.id != account_id for account in state.tracked_accounts)
    deleted_account = next(
        account for account in bot.tracked_accounts if account.id == account_id
    )
    assert deleted_account.deleted_at

    await bot.shutdown()


@pytest.mark.anyio
async def test_leaderboard_sync_tracks_dynamic_accounts_and_waits_for_net_worth(
    tmp_path,
):
    from app.domains.polymarket.schemas import PolymarketSourceTrade, PolymarketTrader

    bot = await build_live_bot(tmp_path, StaticDoctorExecutor([]))
    bot._net_worth_refresh_task = asyncio.create_task(asyncio.sleep(30))
    trader = PolymarketTrader(
        id="0x2000000000000000000000000000000000000000",
        name="Leader",
        address="0x2000000000000000000000000000000000000000",
        source_reason="Today profit leaderboard trader discovered via Bullpen",
        source="live-read",
    )

    await bot._sync_leaderboard_tracked_accounts_unlocked([trader])
    account = bot.tracked_accounts[-1]

    assert account.tracking_source == "leaderboard"
    assert account.threshold_percent == 5
    assert account.copy_trade_usd == 1
    assert account.net_worth_source == "pending_refresh"

    block = bot._proposal_block_reason(
        PolymarketSourceTrade(
            id="trade-1",
            source_trade_key="trade-1-key",
            trader_id=trader.id,
            trader_name=trader.name,
            trader_address=trader.address,
            clean_trader_identity=trader.address,
            market_id="market",
            market_title="Market",
            outcome="Yes",
            side="BUY",
            price=0.5,
            size_usd=100,
            timestamp="2026-06-12T10:00:00+00:00",
            source="live-read",
        ),
        {
            "created": 0,
            "per_trader_created": defaultdict(int),
        },
    )

    assert block == {
        "kind": "filter",
        "reason": "Tracked account net worth refresh pending.",
    }

    bot._net_worth_refresh_task.cancel()
    await asyncio.gather(bot._net_worth_refresh_task, return_exceptions=True)


@pytest.mark.anyio
async def test_live_limit_update_persists_for_recreated_user_bot(tmp_path, monkeypatch):
    from app.domains.polymarket.schemas import PolymarketLiveLimitUpdate
    from app.domains.polymarket.service import PolymarketBotManager

    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("POLYMARKET_AUTO_START", "false")

    manager = PolymarketBotManager()
    bot = await manager.get_bot(42)
    await bot.update_live_limits(PolymarketLiveLimitUpdate(max_live_trades_per_day=15))
    await manager.shutdown()

    recreated_manager = PolymarketBotManager()
    recreated_bot = await recreated_manager.get_bot(42)

    assert recreated_bot.config.max_live_trades_per_day == 15
    assert (tmp_path / "user-42" / "polymarket-config.json").exists()

    await recreated_manager.shutdown()


class RedeemTrackingExecutor:
    def __init__(self, redeem_error: Exception | None = None):
        self.redeem_calls = 0
        self.claim_calls = 0
        self.redeem_error = redeem_error

    async def doctor(self):
        from app.domains.polymarket.schemas import PolymarketDoctorStatus

        return PolymarketDoctorStatus(ok=True, message="ok")

    async def redeem(self, *, dry_run: bool):
        self.redeem_calls += 1
        if self.redeem_error:
            raise self.redeem_error
        return "{}"

    async def claim(self, *, dry_run: bool):
        self.claim_calls += 1
        return "{}"

    async def execute(self, decision):
        return "{}"


class ReadyBalanceReader:
    async def refresh(self):
        from app.domains.polymarket.schemas import PolymarketBalanceState

        return PolymarketBalanceState(
            status="ready", message="Bullpen account value: 114.07 USD"
        )


@pytest.mark.anyio
async def test_live_read_trades_auto_approve_without_pending_confirmation_caps(
    tmp_path,
):
    from app.domains.polymarket.schemas import (
        PolymarketDoctorStatus,
        PolymarketSourceTrade,
    )

    executor = RedeemTrackingExecutor()
    bot = await build_live_bot(tmp_path, executor)
    bot.config.max_pending_confirmations = 0
    bot.config.max_new_live_proposals_per_poll = 0
    bot.config.max_new_live_proposals_per_trader_per_poll = 0
    bot.config.max_pending_per_trader = 0
    bot.config.proposal_cooldown_seconds_per_trader = 999999
    bot.config.trader_invested_threshold_usd = 0
    bot.running = True
    bot.active_mode = "live-trading"
    bot.live_unlocked = True
    bot.doctor_status = PolymarketDoctorStatus(ok=True, message="ok")

    stats = {
        "created": 0,
        "after_filters": 0,
        "skipped_by_filters": 0,
        "skipped_by_limits": 0,
        "skipped_duplicates": 0,
        "per_trader_created": defaultdict(int),
    }

    for trade_id in ("trade-1", "trade-2"):
        await bot._handle_live_source_trade_unlocked(
            PolymarketSourceTrade(
                id=trade_id,
                source_trade_key=f"live-read:wallet:{trade_id}",
                trader_id="wallet",
                trader_name="wallet",
                trader_address="0xabc",
                clean_trader_identity="0xabc",
                market_id=f"market-{trade_id}",
                market_title="Tennis Match",
                outcome="Player A",
                side="BUY",
                price=0.50,
                size_usd=100,
                timestamp="2026-06-12T10:00:00+00:00",
                source="live-read",
            ),
            stats,
        )

    assert stats["created"] == 2
    assert stats["skipped_by_limits"] == 0
    assert [trade.status for trade in bot.live_trade_history] == [
        "executed",
        "executed",
    ]
    assert bot._pending_live_trades() == []
    assert all("auto-approved" in trade.reason for trade in bot.live_trade_history)


@pytest.mark.anyio
async def test_bullpen_redeem_uses_extended_timeout(monkeypatch):
    calls = []

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        calls.append(
            {
                "args": args,
                "timeout_seconds": timeout_seconds,
                "read_only": read_only,
            }
        )
        return "{}"

    monkeypatch.setattr("app.domains.polymarket.bullpen.run_bullpen", fake_run_bullpen)

    result = await BullpenLiveExecutor().redeem(dry_run=False)

    assert result == "{}"
    assert calls == [
        {
            "args": [
                "polymarket",
                "redeem",
                "--yes",
                "--non-interactive",
                "--output",
                "json",
            ],
            "timeout_seconds": 180,
            "read_only": False,
        }
    ]


def test_bullpen_execution_limit_prices_include_safety_buffer(monkeypatch):
    monkeypatch.delenv("BULLPEN_BUY_MAX_PRICE_BUFFER", raising=False)
    monkeypatch.delenv("BULLPEN_BUY_MIN_PRICE_BUFFER", raising=False)
    monkeypatch.delenv("BULLPEN_SELL_MIN_PRICE_BUFFER", raising=False)

    assert buy_max_price_for_execution(0.65) == pytest.approx(0.75)
    assert buy_max_price_for_execution(0.98) == pytest.approx(0.99)
    assert sell_min_price_for_execution(0.65) == pytest.approx(0.60)
    assert sell_min_price_for_execution(0.02) == pytest.approx(0.01)


def test_bullpen_buy_limit_price_keeps_minimum_buffer_when_configured_zero(monkeypatch):
    monkeypatch.setenv("BULLPEN_BUY_MAX_PRICE_BUFFER", "0")
    monkeypatch.delenv("BULLPEN_BUY_MIN_PRICE_BUFFER", raising=False)

    assert buy_max_price_for_execution(0.19) == pytest.approx(0.21)


@pytest.mark.anyio
async def test_bullpen_execute_uses_buffered_limit_prices(monkeypatch):
    calls = []

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        calls.append(
            {
                "args": args,
                "timeout_seconds": timeout_seconds,
                "read_only": read_only,
            }
        )
        return "{}"

    monkeypatch.delenv("BULLPEN_BUY_MAX_PRICE_BUFFER", raising=False)
    monkeypatch.setattr("app.domains.polymarket.bullpen.run_bullpen", fake_run_bullpen)

    await BullpenLiveExecutor().execute(
        PolymarketLiveTradeDecision(
            id="decision-1",
            source_trade_id="source-1",
            source_trade_key="source-key-1",
            proposed_at="2026-06-13T00:00:00Z",
            updated_at="2026-06-13T00:00:00Z",
            trader_id="trader-1",
            trader_name="Trader 1",
            trader_address="",
            market_id="market-1",
            market_title="Market 1",
            outcome="Yes",
            side="BUY",
            amount=1,
            price=0.65,
            shares=1.538461,
            max_loss=1,
            reason="test",
            status="confirmed",
            command="buy",
            source="live-read",
        )
    )

    assert calls[0]["args"] == [
        "polymarket",
        "buy",
        "market-1",
        "Yes",
        "1.00",
        "--max-price",
        "0.7500",
        "--yes",
        "--non-interactive",
        "--output",
        "json",
    ]


@pytest.mark.anyio
async def test_bullpen_execute_retries_buy_when_fill_price_exceeds_limit(monkeypatch):
    calls = []

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        calls.append(args)
        if len(calls) == 1:
            raise BullpenCommandError(
                '{"error":"Fill price $0.7000 exceeds maximum acceptable price $0.6900. Use a limit order for precise price control, or increase --max-price."}'
            )
        return "{}"

    monkeypatch.setenv("BULLPEN_BUY_MAX_PRICE_BUFFER", "0.05")
    monkeypatch.delenv("BULLPEN_BUY_RETRY_PRICE_BUFFER", raising=False)
    monkeypatch.setattr("app.domains.polymarket.bullpen.run_bullpen", fake_run_bullpen)

    await BullpenLiveExecutor().execute(
        PolymarketLiveTradeDecision(
            id="decision-1",
            source_trade_id="source-1",
            source_trade_key="source-key-1",
            proposed_at="2026-06-13T00:00:00Z",
            updated_at="2026-06-13T00:00:00Z",
            trader_id="trader-1",
            trader_name="Trader 1",
            trader_address="",
            market_id="market-1",
            market_title="Market 1",
            outcome="Yes",
            side="BUY",
            amount=1,
            price=0.64,
            shares=1.5625,
            max_loss=1,
            reason="test",
            status="confirmed",
            command="buy",
            source="live-read",
        )
    )

    assert calls[0][calls[0].index("--max-price") + 1] == "0.6900"
    assert calls[1][calls[1].index("--max-price") + 1] == "0.7200"


@pytest.mark.anyio
async def test_bullpen_execute_retries_multiple_moving_buy_fill_prices(monkeypatch):
    calls = []

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        calls.append(args)
        if len(calls) == 1:
            raise BullpenCommandError(
                '{"error":"Fill price $0.2000 exceeds maximum acceptable price $0.1900. Use a limit order for precise price control, or increase --max-price."}'
            )
        if len(calls) == 2:
            raise BullpenCommandError(
                '{"error":"Fill price $0.2300 exceeds maximum acceptable price $0.2200. Use a limit order for precise price control, or increase --max-price."}'
            )
        return "{}"

    monkeypatch.setenv("BULLPEN_BUY_MAX_PRICE_BUFFER", "0")
    monkeypatch.delenv("BULLPEN_BUY_MIN_PRICE_BUFFER", raising=False)
    monkeypatch.delenv("BULLPEN_BUY_RETRY_PRICE_BUFFER", raising=False)
    monkeypatch.setattr("app.domains.polymarket.bullpen.run_bullpen", fake_run_bullpen)

    await BullpenLiveExecutor().execute(
        PolymarketLiveTradeDecision(
            id="decision-1",
            source_trade_id="source-1",
            source_trade_key="source-key-1",
            proposed_at="2026-06-13T00:00:00Z",
            updated_at="2026-06-13T00:00:00Z",
            trader_id="trader-1",
            trader_name="Trader 1",
            trader_address="",
            market_id="market-1",
            market_title="Market 1",
            outcome="No",
            side="BUY",
            amount=1,
            price=0.17,
            shares=5.882353,
            max_loss=1,
            reason="test",
            status="confirmed",
            command="buy",
            source="live-read",
        )
    )

    assert [call[call.index("--max-price") + 1] for call in calls] == [
        "0.1900",
        "0.2200",
        "0.2500",
    ]


@pytest.mark.anyio
async def test_bullpen_execute_wraps_collateral_then_retries_buy(monkeypatch):
    calls = []

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        calls.append(args)
        if len(calls) in {1, 3}:
            raise BullpenCommandError(
                '{"error":"Insufficient collateral to place this order (1.020000 pUSD needed). Wrap USDC first: `bullpen polymarket wrap <AMOUNT> --yes`"}'
            )
        return "{}"

    monkeypatch.setattr("app.domains.polymarket.bullpen.run_bullpen", fake_run_bullpen)

    await BullpenLiveExecutor().execute(
        PolymarketLiveTradeDecision(
            id="decision-1",
            source_trade_id="source-1",
            source_trade_key="source-key-1",
            proposed_at="2026-06-13T00:00:00Z",
            updated_at="2026-06-13T00:00:00Z",
            trader_id="trader-1",
            trader_name="Trader 1",
            trader_address="",
            market_id="market-1",
            market_title="Market 1",
            outcome="Yes",
            side="BUY",
            amount=1,
            price=0.64,
            shares=1.5625,
            max_loss=1,
            reason="test",
            status="confirmed",
            command="buy",
            source="live-read",
        )
    )

    assert calls[1] == [
        "polymarket",
        "redeem",
        "--yes",
        "--non-interactive",
        "--output",
        "json",
    ]
    assert calls[3] == [
        "polymarket",
        "wrap",
        "1.02",
        "--yes",
        "--non-interactive",
        "--output",
        "json",
    ]
    assert calls[4][0:2] == ["polymarket", "buy"]


@pytest.mark.anyio
async def test_bullpen_execute_redeems_collateral_then_retries_buy(monkeypatch):
    calls = []

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        calls.append(args)
        if len(calls) == 1:
            raise BullpenCommandError(
                '{"error":"Insufficient collateral to place this order (1.020000 pUSD needed). Wrap USDC first: `bullpen polymarket wrap <AMOUNT> --yes`"}'
            )
        return "{}"

    monkeypatch.setattr("app.domains.polymarket.bullpen.run_bullpen", fake_run_bullpen)

    await BullpenLiveExecutor().execute(
        PolymarketLiveTradeDecision(
            id="decision-1",
            source_trade_id="source-1",
            source_trade_key="source-key-1",
            proposed_at="2026-06-13T00:00:00Z",
            updated_at="2026-06-13T00:00:00Z",
            trader_id="trader-1",
            trader_name="Trader 1",
            trader_address="",
            market_id="market-1",
            market_title="Market 1",
            outcome="Yes",
            side="BUY",
            amount=1,
            price=0.64,
            shares=1.5625,
            max_loss=1,
            reason="test",
            status="confirmed",
            command="buy",
            source="live-read",
        )
    )

    assert [call[0:2] for call in calls] == [
        ["polymarket", "buy"],
        ["polymarket", "redeem"],
        ["polymarket", "buy"],
    ]


def test_extract_bullpen_insufficient_collateral_amount():
    assert extract_bullpen_insufficient_collateral_amount(
        "Insufficient collateral to place this order (1.020000 pUSD needed)."
    ) == pytest.approx(1.02)


def test_redeem_metadata_lookup_warning_detects_gamma_condition_miss():
    assert is_redeem_metadata_lookup_warning(
        "[warn] 0xd9027272: payoutDenominator preflight RPC failed "
        "(falling through to relayer): market not found in Gamma for condition "
        "[REDACTED_PRIVATE_KEY]"
    )


@pytest.mark.anyio
async def test_manual_live_redeem_treats_gamma_condition_miss_as_non_fatal(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": True,
            "use_live_reads": True,
            "auto_redeem_live": False,
            "data_dir": str(tmp_path),
        }
    )
    provider = EmptyProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    executor = RedeemTrackingExecutor(
        BullpenCommandError(
            "[warn] 0xd9027272: payoutDenominator preflight RPC failed "
            "(falling through to relayer): market not found in Gamma for condition "
            "[REDACTED_PRIVATE_KEY]"
        )
    )
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=executor,
        balance_reader=ReadyBalanceReader(),
        logger=logger,
    )

    await bot.redeem_live_positions()

    assert executor.redeem_calls == 1
    assert executor.claim_calls == 1
    assert bot.balance_state.message == "Bullpen account value: 114.07 USD"
    assert bot.recent_activity[0].message == (
        "Bullpen redeem checked resolved positions but skipped a market missing Gamma metadata."
    )


@pytest.mark.anyio
async def test_startup_balance_refresh_runs_auto_redeem(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": True,
            "use_live_reads": True,
            "auto_redeem_live": True,
            "data_dir": str(tmp_path),
        }
    )
    provider = EmptyProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    executor = RedeemTrackingExecutor()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=executor,
        balance_reader=ReadyBalanceReader(),
        logger=logger,
    )

    await bot._refresh_startup_balance_background()

    assert executor.redeem_calls == 1
    assert executor.claim_calls == 1
    assert bot.balance_state.message == "Bullpen account value: 114.07 USD"


@pytest.mark.anyio
async def test_manual_live_redeem_submits_and_refreshes_balance(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": True,
            "use_live_reads": True,
            "auto_redeem_live": False,
            "data_dir": str(tmp_path),
        }
    )
    provider = EmptyProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    executor = RedeemTrackingExecutor()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=executor,
        balance_reader=ReadyBalanceReader(),
        logger=logger,
    )

    await bot.redeem_live_positions()

    assert executor.redeem_calls == 1
    assert executor.claim_calls == 1
    assert bot.balance_state.message == "Bullpen account value: 114.07 USD"
    assert bot.recent_activity[0].message == (
        "Manual Bullpen redeem/claim submitted for all resolved positions."
    )


def test_claim_command_unavailable_warning_detects_missing_claim_command():
    assert is_claim_command_unavailable_warning("unknown command: claim for polymarket")


@pytest.mark.anyio
async def test_forced_redeem_claim_runs_even_when_auto_redeem_disabled(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": True,
            "use_live_reads": True,
            "auto_redeem_live": False,
            "data_dir": str(tmp_path),
        }
    )
    provider = EmptyProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    executor = RedeemTrackingExecutor()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=executor,
        balance_reader=ReadyBalanceReader(),
        logger=logger,
    )

    await bot._force_redeem_claim_background()

    assert executor.redeem_calls == 1
    assert executor.claim_calls == 1
    assert bot.recent_activity[0].message == (
        "Forced redeem/claim checked completed Bullpen positions."
    )
