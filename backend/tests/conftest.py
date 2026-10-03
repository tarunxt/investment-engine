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
