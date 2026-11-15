"""Offline migration contract tests; no Alembic CLI or database migration runs."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.domains.runs.side_effect_policy import permits_side_effects


MIGRATION = Path(__file__).resolve().parents[1] / "alembic/versions/audit7_run_policy_001.py"


def load_migration():
    spec = importlib.util.spec_from_file_location("run_policy_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_adds_only_nullable_policy_without_default_or_historical_rewrite(monkeypatch):
    migration = load_migration()
    operations = []
    monkeypatch.setattr(migration, "op", SimpleNamespace(add_column=lambda table, column: operations.append((table, column))))
    migration.upgrade()
    assert len(operations) == 1
    table, column = operations[0]
    assert table == "auto_rebalance_workflows"
    assert column.name == "side_effect_policy_json"
    assert isinstance(column.type, sa.JSON)
    assert column.nullable is True
    assert column.default is None
    assert column.server_default is None
    assert str(sa.schema.CreateColumn(column).compile(dialect=postgresql.dialect())) == "side_effect_policy_json JSON"
    # Existing rows receive NULL; the legacy policy keeps original defaults.
    assert permits_side_effects(None) is True


def test_rollback_removes_only_policy_column_and_upgrade_can_be_reapplied(monkeypatch):
    migration = load_migration()
    operations = []
    monkeypatch.setattr(migration, "op", SimpleNamespace(
        add_column=lambda table, column: operations.append(("add", table, column.name)),
        drop_column=lambda table, column: operations.append(("drop", table, column)),
    ))
    migration.upgrade()
    migration.downgrade()
    migration.upgrade()
    assert operations == [
        ("add", "auto_rebalance_workflows", "side_effect_policy_json"),
        ("drop", "auto_rebalance_workflows", "side_effect_policy_json"),
        ("add", "auto_rebalance_workflows", "side_effect_policy_json"),
    ]
    assert migration.down_revision == "recommendation_audit_001"
    assert migration.revision == "audit7_run_policy_001"
