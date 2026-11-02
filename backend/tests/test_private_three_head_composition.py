"""Offline composition checks; no connection, migration activation or data proof."""
import ast
from io import StringIO
from pathlib import Path
import runpy

from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ROOT / "alembic" / "versions"
MERGE = "a12_three_head_merge_001"
BRANCHES = {"jobs_admission_dispatch_001", "a12_collection_intent_001", "rebalance_spend_refund_002"}


def scripts():
    return ScriptDirectory(str(ROOT / "alembic"))


def test_one_head_preserves_original_ancestry():
    graph = scripts()
    assert graph.get_heads() == [MERGE]
    assert set(graph.get_revision(MERGE).down_revision) == BRANCHES
    for name in ("jobs_admission_dispatch_001", "a12_collection_intent_001", "rebalance_spend_cap_001"):
        assert graph.get_revision(name).down_revision == "audit7_run_policy_001"
    assert graph.get_revision("rebalance_spend_refund_002").down_revision == "rebalance_spend_cap_001"


def test_forward_postgresql_ddl_is_additive_and_orders_refund_after_cap():
    graph = scripts()
    revisions = list(reversed(list(graph.iterate_revisions(MERGE, "audit7_run_policy_001"))))
    assert {r.revision for r in revisions} == BRANCHES | {"rebalance_spend_cap_001", MERGE}
    assert [r.revision for r in revisions].index("rebalance_spend_cap_001") < [r.revision for r in revisions].index("rebalance_spend_refund_002")
    output = StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": output})
    with Operations.context(context):
        for revision in revisions:
            revision.module.upgrade()
    sql = output.getvalue()
    for name in ("job_admissions", "cost_collection_intents", "rebalance_spend_scopes", "rebalance_spend_bindings", "rebalance_spend_attempts", "rebalance_spend_refunds"):
        assert f"CREATE TABLE {name}" in sql
    assert "REFERENCES users (id)" in sql and "REFERENCES jobs (id)" in sql
    statements = [part.strip().split()[0].upper() for part in sql.split(";") if part.strip()]
    assert not {"DROP", "DELETE", "TRUNCATE", "UPDATE", "INSERT"}.intersection(statements)


def test_merge_up_and_down_emit_no_schema_or_data_changes():
    output = StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": output})
    module = runpy.run_path(str(VERSIONS / (MERGE + ".py")))
    with Operations.context(context):
        module["upgrade"]()
        module["downgrade"]()
    assert output.getvalue() == ""


def test_production_rollback_must_not_call_destructive_sibling_downgrades():
    # Characterize source, without executing DROP even against a fixture.
    for name in ("rebalance_spend_cap_001", "rebalance_spend_refund_002"):
        tree = ast.parse((VERSIONS / (name + ".py")).read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "downgrade")
        assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "drop_table" for n in ast.walk(function))
    for name in ("jobs_admission_dispatch_001", "a12_collection_intent_001"):
        tree = ast.parse((VERSIONS / (name + ".py")).read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "downgrade")
        assert any(isinstance(n, ast.Raise) for n in ast.walk(function))
