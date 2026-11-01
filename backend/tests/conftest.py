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


@pytest.fixture(autouse=True)
def isolate_cost_collection_intents(request, monkeypatch, tmp_path):
    """Cost tests use an isolated synthetic ledger, never a runtime database."""
    if not request.node.path.name.startswith("test_cost"):
        return
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.domains.cost_drivers import admission
    from app.domains.cost_drivers.models import CostCollectionIntent
    engine = create_engine(f"sqlite:///{tmp_path / 'collection-intents.db'}", connect_args={"timeout": 3})
    CostCollectionIntent.__table__.create(engine)
    monkeypatch.setattr(admission, "SyncSessionLocal", sessionmaker(bind=engine))
    yield
    engine.dispose()
