import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.runs.router import _next_auto_rebalance_sequence


def test_next_auto_rebalance_sequence_continues_from_redis_counter():
    assert _next_auto_rebalance_sequence("7", 3) == 8


def test_next_auto_rebalance_sequence_recovers_when_redis_counter_is_missing():
    assert _next_auto_rebalance_sequence(None, 7) == 8


def test_next_auto_rebalance_sequence_recovers_when_redis_counter_is_stale_or_invalid():
    assert _next_auto_rebalance_sequence("1", 7) == 8
    assert _next_auto_rebalance_sequence("not-a-number", 7) == 8
