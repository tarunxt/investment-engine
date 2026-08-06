from __future__ import annotations

from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
patcher = root / "scripts/apply_final_actionable_history_patch.py"
source = patcher.read_text(encoding="utf-8")

model_old = """replace_once(
    \"backend/app/models/__init__.py\",
    '    \"AutoRebalanceWorkflowStage\",\\n    \"Run\",',
    '    \"AutoRebalanceWorkflowStage\",\\n    \"FinalActionableHistory\",\\n    \"Run\",',
)"""
model_new = """replace_once(
    \"backend/app/models/__init__.py\",
    '    \"AutoRebalanceWorkflowStage\",\\n    \"BullpenRunAuditBlobRecord\",',
    '    \"AutoRebalanceWorkflowStage\",\\n    \"FinalActionableHistory\",\\n    \"BullpenRunAuditBlobRecord\",',
)"""
if source.count(model_old) != 1:
    raise RuntimeError(
        f"Expected one obsolete model export patch, found {source.count(model_old)}"
    )
source = source.replace(model_old, model_new, 1)

api_import_old = """# Add imports to both service files.
for api_path in (\"frontend/services/api.ts\", \"frontend/services/api.types.ts\"):
    replace_once(
        api_path,
        \"    AutoRebalanceStageUpdateRequest,\",
        \"    AutoRebalanceStageUpdateRequest,\\n\"
        \"    FinalActionableHistoryBackfillResponse,\\n\"
        \"    FinalActionableHistoryBulkCreateRequest,\\n\"
        \"    FinalActionableHistoryBulkCreateResponse,\\n\"
        \"    FinalActionableHistoryListResponse,\",
    )"""
api_import_new = """# Add imports to both service files using each file's established indentation.
replace_once(
    \"frontend/services/api.ts\",
    \"  AutoRebalanceStageUpdateRequest,\",
    \"  AutoRebalanceStageUpdateRequest,\\n\"
    \"  FinalActionableHistoryBackfillResponse,\\n\"
    \"  FinalActionableHistoryBulkCreateRequest,\\n\"
    \"  FinalActionableHistoryBulkCreateResponse,\\n\"
    \"  FinalActionableHistoryListResponse,\",
)
replace_once(
    \"frontend/services/api.types.ts\",
    \"    AutoRebalanceStageUpdateRequest,\",
    \"    AutoRebalanceStageUpdateRequest,\\n\"
    \"    FinalActionableHistoryBackfillResponse,\\n\"
    \"    FinalActionableHistoryBulkCreateRequest,\\n\"
    \"    FinalActionableHistoryBulkCreateResponse,\\n\"
    \"    FinalActionableHistoryListResponse,\",
)"""
if source.count(api_import_old) != 1:
    raise RuntimeError(
        f"Expected one obsolete API import patch, found {source.count(api_import_old)}"
    )
source = source.replace(api_import_old, api_import_new, 1)

patcher.write_text(source, encoding="utf-8")
runpy.run_path(str(patcher), run_name="__main__")
Path(__file__).unlink(missing_ok=True)
