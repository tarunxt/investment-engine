"""Graph/source inspection only; no migration upgrade/downgrade execution."""
import ast
from pathlib import Path

from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]
MERGE = "audits_session_merge_001"


def test_source_merge_preserves_both_histories_and_original_edges():
    graph = ScriptDirectory(str(ROOT / "alembic"))
    assert graph.get_heads() == [MERGE]
    assert set(graph.get_revision(MERGE).down_revision) == {"a12_three_head_merge_001", "session_families_001"}
    assert graph.get_revision("session_families_001").down_revision == "z3a4b5c6d7e8"
    assert set(graph.get_revision("a12_three_head_merge_001").down_revision) == {"jobs_admission_dispatch_001", "a12_collection_intent_001", "rebalance_spend_refund_002"}
    ancestry = {r.revision for r in graph.iterate_revisions(MERGE, "base")}
    for parent in ("a12_three_head_merge_001", "session_families_001"):
        assert {r.revision for r in graph.iterate_revisions(parent, "base")} <= ancestry


def test_merge_is_explicitly_no_op_in_both_directions():
    source = (ROOT / "alembic/versions" / (MERGE + ".py")).read_text()
    tree = ast.parse(source)
    for name in ("upgrade", "downgrade"):
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
        assert len(function.body) == 1 and isinstance(function.body[0], ast.Pass)
