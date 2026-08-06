from __future__ import annotations

from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
patcher = root / "scripts/apply_final_actionable_history_patch.py"
source = patcher.read_text(encoding="utf-8")

replacements = [
    (
        """replace_once(
    \"backend/app/models/__init__.py\",
    '    \"AutoRebalanceWorkflowStage\",\\n    \"Run\",',
    '    \"AutoRebalanceWorkflowStage\",\\n    \"FinalActionableHistory\",\\n    \"Run\",',
)""",
        """replace_once(
    \"backend/app/models/__init__.py\",
    '    \"AutoRebalanceWorkflowStage\",\\n    \"BullpenRunAuditBlobRecord\",',
    '    \"AutoRebalanceWorkflowStage\",\\n    \"FinalActionableHistory\",\\n    \"BullpenRunAuditBlobRecord\",',
)""",
        "model export",
    ),
    (
        """# Add imports to both service files.
for api_path in (\"frontend/services/api.ts\", \"frontend/services/api.types.ts\"):
    replace_once(
        api_path,
        \"    AutoRebalanceStageUpdateRequest,\",
        \"    AutoRebalanceStageUpdateRequest,\\n\"
        \"    FinalActionableHistoryBackfillResponse,\\n\"
        \"    FinalActionableHistoryBulkCreateRequest,\\n\"
        \"    FinalActionableHistoryBulkCreateResponse,\\n\"
        \"    FinalActionableHistoryListResponse,\",
    )""",
        """# Add imports to both service files using each file's established indentation.
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
)""",
        "API import",
    ),
    (
        '    "  async getAutoRebalanceHistory(\\n",',
        '    "  getAutoRebalanceHistory(\\n",',
        "API method anchor",
    ),
]

for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one obsolete {label} patch, found {count}")
    source = source.replace(old, new, 1)

patcher.write_text(source, encoding="utf-8")
runpy.run_path(str(patcher), run_name="__main__")
Path(__file__).unlink(missing_ok=True)
