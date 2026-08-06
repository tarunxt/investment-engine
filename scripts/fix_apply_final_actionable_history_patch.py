from __future__ import annotations

from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
patcher = root / "scripts/apply_final_actionable_history_patch.py"
source = patcher.read_text(encoding="utf-8")
old = """replace_once(\n    \"backend/app/models/__init__.py\",\n    '    \"AutoRebalanceWorkflowStage\",\\n    \"Run\",',\n    '    \"AutoRebalanceWorkflowStage\",\\n    \"FinalActionableHistory\",\\n    \"Run\",',\n)"""
new = """replace_once(\n    \"backend/app/models/__init__.py\",\n    '    \"AutoRebalanceWorkflowStage\",\\n    \"BullpenRunAuditBlobRecord\",',\n    '    \"AutoRebalanceWorkflowStage\",\\n    \"FinalActionableHistory\",\\n    \"BullpenRunAuditBlobRecord\",',\n)"""
if source.count(old) != 1:
    raise RuntimeError(f"Expected one obsolete model export patch, found {source.count(old)}")
patcher.write_text(source.replace(old, new, 1), encoding="utf-8")
runpy.run_path(str(patcher), run_name="__main__")
Path(__file__).unlink(missing_ok=True)
