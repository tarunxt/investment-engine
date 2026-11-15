import os

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import runtime_positions_refresh as refresh_module


WALLET = "0xa70b18abdebf0704b41901c33e8477ea1085afdf"


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.expirations: dict[str, int | None] = {}

    async def get(self, key: str):
        return self.values.get(key)

    async def set(
        self,
        key: str,
        value: str,
        ex: int | None = None,
        nx: bool = False,
    ):
        if nx and key in self.values:
            return None
        self.values[key] = value
        self.expirations[key] = ex
        return True


class FakeBroker:
    def __init__(self, redis: FakeRedis) -> None:
        self._redis = redis
        self._version_cache_value = None

    async def execute_raw(self, *_args, **_kwargs):
        raise RuntimeError("canonical Bullpen CLI auth is unavailable")

    async def read_latest_active_auth_result(self):
        return None

    async def _read_positions_snapshot(self, _key: str):
        # Simulate both the 24-hour display LKG and the shorter execution cache
        # having expired, which is the production regression this guards.
        return None


@pytest.mark.anyio
async def test_persisted_display_wallet_identity_survives_expiring_snapshots():
    redis = FakeRedis()
    broker = FakeBroker(redis)

    persisted = await refresh_module._persist_display_wallet_identity(broker, WALLET)

    assert persisted == WALLET
    assert redis.values[refresh_module._DISPLAY_WALLET_IDENTITY_KEY] == WALLET
    assert redis.expirations[refresh_module._DISPLAY_WALLET_IDENTITY_KEY] is None
    assert await refresh_module._status_wallet_address(broker) == WALLET


@pytest.mark.anyio
async def test_public_refresh_recovers_current_two_positions_from_persisted_identity(
    monkeypatch: pytest.MonkeyPatch,
):
    redis = FakeRedis()
    broker = FakeBroker(redis)
    await redis.set(refresh_module._DISPLAY_WALLET_IDENTITY_KEY, WALLET)

    async def fake_public_payload(wallet: str):
        assert wallet == WALLET
        return {
            "_meta": {
                "source": "polymarket-public-data-api",
                "wallet_address": WALLET,
                "display_only": True,
            },
            "positions": [
                {
                    "market": "Israel x Iran ceasefire continues through August 15?",
                    "outcome": "Yes",
                    "shares": 5.4945,
                    "current_value": 5.23,
                    "redeemable": False,
                },
                {
                    "market": "Iran full airspace closure by August 15?",
                    "outcome": "No",
                    "shares": 3.0166,
                    "current_value": 2.87,
                    "redeemable": False,
                },
            ],
            "summary": {
                "active_count": 2,
                "cash_balance": 14.80,
                "claimable_count": 0,
                "claimable_value": 0.0,
                "total_value": 22.90,
                "unrealized_pnl": 1.30,
                "wallet_value": 8.10,
            },
        }

    monkeypatch.setattr(
        refresh_module,
        "_read_public_positions_payload",
        fake_public_payload,
    )

    snapshot = await refresh_module._refresh_public_wallet_snapshot(
        broker,
        caller_source="ui-history-portfolio-refresh",
    )

    assert snapshot.account_identity == WALLET
    assert snapshot.source == "redis-cache"
    assert snapshot.freshness_state == "cached"
    assert len(snapshot.payload["positions"]) == 2
    assert snapshot.payload["summary"]["active_count"] == 2
    assert redis.values[refresh_module._DISPLAY_WALLET_IDENTITY_KEY] == WALLET
