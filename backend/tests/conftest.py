import os
import pytest


os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("GEMINI_API_KEY", "test-gemini-key")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-anthropic-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-deepseek-key")


@pytest.fixture(autouse=True)
def isolate_api_usage_telemetry(monkeypatch):
    """Existing mocked provider tests must not open a real telemetry database.

    Ledger tests explicitly restore persistence against their in-memory DB.
    """
    from app.domains.api_usage import metering

    monkeypatch.setattr(metering, "_persist_attempt", lambda values: None)


@pytest.fixture
def synthetic_operator_unit_context(monkeypatch):
    """Unit-test admitted operator logic; real admission is tested in Stage05.

    Existing detached bot/projection/worker fixtures have no users database.
    They opt in explicitly, while HTTP/SQL negative tests never use this.
    """
    import importlib
    from unittest.mock import AsyncMock, Mock
    for domain, file in (
        ('polymarket','service'), ('polymarket_direct','service'),
        ('polymarket_auto_live','service'), ('trading_bots','service'),
        ('dashboard','service'), ('bullpen_trade_analysis','service'),
        ('trading_bots','tasks'), ('bullpen_trade_analysis','tasks'),
        ('polymarket_auto_live','tasks'), ('bullpen008','tasks'),
        ('polymarket_auto_live','order_intent_service'), ('polymarket_auto_live','export_tasks'),
    ):
        module=importlib.import_module(f'app.domains.{domain}.{file}')
        for name in ('require_operator_user_id','require_operator_user_id_sync','require_operator_intent_sync','require_operator_bullpen008_run_sync'):
            if hasattr(module,name):
                monkeypatch.setattr(module,name,AsyncMock() if name=='require_operator_user_id' else Mock())
