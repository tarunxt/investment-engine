import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.runs.router import (
    _base_auto_rebalance_label,
    _infer_auto_rebalance_stage,
    _next_auto_rebalance_sequence,
)


def test_next_auto_rebalance_sequence_continues_from_redis_counter():
    assert _next_auto_rebalance_sequence("7", 3) == 8


def test_next_auto_rebalance_sequence_recovers_when_redis_counter_is_missing():
    assert _next_auto_rebalance_sequence(None, 7) == 8


def test_next_auto_rebalance_sequence_recovers_when_redis_counter_is_stale_or_invalid():
    assert _next_auto_rebalance_sequence("1", 7) == 8
    assert _next_auto_rebalance_sequence("not-a-number", 7) == 8


def test_auto_rebalance_history_normalizes_stage_labels_and_legacy_threat_jobs():
    assert _base_auto_rebalance_label("India Run #12 (Rebalance Scan)", "india", 12) == "India Run #12"
    assert _infer_auto_rebalance_stage("India Run #12", "[ZERODHA_THREATS]\nportfolio") == "threats"
    assert _infer_auto_rebalance_stage("IndMoney US Run #12 (Technical Scan)", "") == "technical"
    assert _infer_auto_rebalance_stage("IndMoney US Run #12 (Rebalance Scan)", "") == "rebalance"
