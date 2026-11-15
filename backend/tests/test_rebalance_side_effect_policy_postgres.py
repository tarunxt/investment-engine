"""Scoped Alembic round trip; CI executes this inside its Docker backend job."""
import os
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from sqlalchemy.schema import CreateSchema, DropSchema


def test_policy_migration_preserves_legacy_workflow_on_upgrade_rollback_and_reapply(monkeypatch):
    raw = os.environ.get("CREDX_AUDIT_TEST_POSTGRES_URL")
    if not raw:
        pytest.skip("Docker release gate requires an explicit disposable PostgreSQL target")
    url = sa.engine.make_url(raw)
    assert os.environ.get("CREDX_AUDIT_DISPOSABLE_DB") == "1"
    assert url.host in {"postgres", "localhost", "127.0.0.1"}
    assert (url.database or "").startswith("credx_audit_test_") and not url.query
    url = url.set(drivername="postgresql+psycopg2")
    schema = "audit7_migration_" + uuid.uuid4().hex
    admin = sa.create_engine(url)
    with admin.begin() as db:
        db.execute(CreateSchema(schema))
    scoped_url = url.update_query_dict({"options": "-csearch_path=" + schema})
    monkeypatch.setenv("DATABASE_URL", scoped_url.render_as_string(hide_password=False))
    engine = sa.create_engine(scoped_url)
    try:
        import app.models  # noqa: F401
        from app.domains.auth.models import User
        from app.domains.runs.models import AutoRebalanceWorkflow
        metadata = sa.MetaData()
        users = User.__table__.to_metadata(metadata)
        workflow = AutoRebalanceWorkflow.__table__.to_metadata(metadata)
        workflow._columns.remove(workflow.c.side_effect_policy_json)
        metadata.create_all(engine)
        with engine.begin() as db:
            db.execute(users.insert().values(id=7001, email="fixture@example.test", username="fixture", password_hash="unused"))
            db.execute(workflow.insert().values(id=7001, user_id=7001, portfolio="india", sequence=1, label="Synthetic Run"))
        backend = Path(__file__).resolve().parents[1]
        config = Config(str(backend / "alembic.ini"))
        config.set_main_option("script_location", str(backend / "alembic"))
        command.stamp(config, "recommendation_audit_001")
        for iteration in range(2):
            command.upgrade(config, "audit7_run_policy_001")
            assert "side_effect_policy_json" in {column["name"] for column in sa.inspect(engine).get_columns("auto_rebalance_workflows")}
            table = sa.Table("auto_rebalance_workflows", sa.MetaData(), autoload_with=engine)
            with engine.connect() as db:
                row = db.execute(sa.select(table).where(table.c.id == 7001)).mappings().one()
                assert row["sequence"] == 1 and row["side_effect_policy_json"] is None
            if iteration == 0:
                command.downgrade(config, "recommendation_audit_001")
                assert "side_effect_policy_json" not in {column["name"] for column in sa.inspect(engine).get_columns("auto_rebalance_workflows")}
    finally:
        engine.dispose()
        with admin.begin() as db:
            db.execute(DropSchema(schema, cascade=True))
        admin.dispose()
