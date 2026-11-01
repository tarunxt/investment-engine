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
    test_url = os.environ.get("COST_TEST_POSTGRES_URL")
    if test_url:
        from uuid import uuid4
        from sqlalchemy.engine import make_url
        from sqlalchemy.schema import CreateSchema, DropSchema
        url = make_url(test_url)
        # Explicit disposable socket-only fixture; refuse runtime/account URLs.
        if (url.database != "cost_fixture" or url.username != "cost_fixture"
                or url.host is not None
                or url.query.get("host") != "/tmp/cost-a12-pg18-socket"):
            pytest.fail("COST_TEST_POSTGRES_URL must target the isolated cost fixture")
        schema = "cost_test_" + uuid4().hex
        admin = create_engine(url)
        with admin.begin() as connection:
            connection.execute(CreateSchema(schema))
        engine = create_engine(url.update_query_dict({"options": "-csearch_path=" + schema}))
    else:
        engine = create_engine(f"sqlite:///{tmp_path / 'collection-intents.db'}", connect_args={"timeout": 3})
    CostCollectionIntent.__table__.create(engine)
    monkeypatch.setattr(admission, "SyncSessionLocal", sessionmaker(bind=engine))
    yield
    engine.dispose()
    if test_url:
        with admin.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        admin.dispose()
