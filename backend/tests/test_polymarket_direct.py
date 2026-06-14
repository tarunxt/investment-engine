import asyncio
from pathlib import Path

import pytest

from app.domains.polymarket_direct.config import load_polymarket_config
from app.domains.polymarket_direct.direct_polymarket import (
    DIRECT_EXECUTION_NOT_CONFIGURED,
    DirectPolymarketCommandError,
    DirectPolymarketLiveExecutor,
)


def test_direct_domain_does_not_import_bullpen_execution_symbols():
    source = "\n".join(
        path.read_text()
        for path in Path("backend/app/domains/polymarket_direct").glob("*.py")
    )
    forbidden = [
        "run_bullpen",
        "BullpenLiveExecutor",
        "BullpenBalanceReader",
        "app.domains.polymarket.bullpen",
    ]
    for symbol in forbidden:
        assert symbol not in source


def test_direct_live_executor_fails_safely_when_not_configured():
    async def scenario():
        executor = DirectPolymarketLiveExecutor()
        doctor = await executor.doctor()
        assert doctor.ok is False
        assert DIRECT_EXECUTION_NOT_CONFIGURED in doctor.message
        with pytest.raises(DirectPolymarketCommandError, match="not configured"):
            await executor.redeem(dry_run=False)

    asyncio.run(scenario())


def test_direct_config_uses_direct_env_prefix(monkeypatch, tmp_path):
    monkeypatch.setenv("POLYMARKET_DIRECT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("POLYMARKET_DIRECT_AUTO_START", "false")
    monkeypatch.setenv("POLYMARKET_DIRECT_LIVE_TRADING", "false")

    config = load_polymarket_config()

    assert config.data_dir == str(tmp_path)
    assert config.auto_start is False
    assert config.live_trading is False
