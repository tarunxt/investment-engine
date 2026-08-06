from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


history_path = "backend/app/domains/runs/final_actionable_history.py"

replace_once(
    history_path,
    "from app.domains.runs.models import FinalActionableHistory, Run, RunJob",
    "from app.domains.runs.models import (\n"
    "    AutoRebalanceWorkflow,\n"
    "    FinalActionableHistory,\n"
    "    Run,\n"
    "    RunJob,\n"
    ")",
)

replace_once(
    history_path,
    '''    run_ids = {item.rebalance_run_id for item in items}
    technical_ids = {item.technical_scan_run_id for item in items if item.technical_scan_run_id}
    all_run_ids = run_ids | technical_ids
    owned_ids = set(
        (await db.execute(select(Run.id).where(Run.user_id == user_id, Run.id.in_(all_run_ids))))
        .scalars()
        .all()
    )
    if owned_ids != all_run_ids:
        raise ValueError("One or more referenced runs do not belong to the current user")
''',
    '''    run_ids = {item.rebalance_run_id for item in items}
    technical_ids = {item.technical_scan_run_id for item in items if item.technical_scan_run_id}
    source_ids = {
        source_id
        for item in items
        for source_id in item.source_run_ids_json
    }
    all_run_ids = run_ids | technical_ids | source_ids
    owned_ids = set(
        (await db.execute(select(Run.id).where(Run.user_id == user_id, Run.id.in_(all_run_ids))))
        .scalars()
        .all()
    )
    if owned_ids != all_run_ids:
        raise ValueError("One or more referenced runs do not belong to the current user")

    workflow_ids = {item.workflow_id for item in items if item.workflow_id is not None}
    if workflow_ids:
        owned_workflow_ids = set(
            (
                await db.execute(
                    select(AutoRebalanceWorkflow.id).where(
                        AutoRebalanceWorkflow.user_id == user_id,
                        AutoRebalanceWorkflow.id.in_(workflow_ids),
                    )
                )
            )
            .scalars()
            .all()
        )
        if owned_workflow_ids != workflow_ids:
            raise ValueError("One or more referenced workflows do not belong to the current user")
''',
)

replace_once(
    history_path,
    '''    payloads = list(payload_by_key.values())
    if not payloads:
        return 0, 0, 0

    statement = pg_insert(FinalActionableHistory).values(payloads)
''',
    '''    payload_defaults = {
        "workflow_id": None,
        "auto_rebalance_sequence": None,
        "stock_name": None,
        "action": None,
        "score": None,
        "consensus_numerator": None,
        "consensus_denominator": None,
        "historical_current_units": None,
        "historical_current_value": None,
        "action_units": None,
        "amount": None,
        "technical_scan_run_id": None,
        "formula_inputs_json": None,
        "source_run_ids_json": None,
        "snapshot_json": None,
    }
    # SQLAlchemy multi-row INSERT requires a consistent key set for every row.
    # Coverage rows intentionally omit recommendation fields, so normalize them
    # to explicit NULLs before constructing the PostgreSQL upsert.
    payloads = [
        {**payload_defaults, **payload}
        for payload in payload_by_key.values()
    ]
    if not payloads:
        return 0, 0, 0

    statement = pg_insert(FinalActionableHistory).values(payloads)
''',
)

# Mark a successful legacy backfill for one year. The route's initial one-hour
# Redis lock still expires after failures, while successful users avoid a full
# historical rescan on every dashboard visit.
tasks_path = "backend/app/domains/runs/tasks.py"
replace_once(
    tasks_path,
    "from html import escape\n\nfrom sqlalchemy import select",
    "from html import escape\n\nimport redis\nfrom sqlalchemy import select",
)
replace_once(
    tasks_path,
    "TERMINAL_RUN_STATUSES = {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}\n",
    "TERMINAL_RUN_STATUSES = {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}\n"
    "FINAL_ACTIONABLE_HISTORY_BACKFILL_TTL_SECONDS = 365 * 24 * 60 * 60\n\n\n"
    "def _mark_final_actionable_history_backfill_complete(user_id: int) -> None:\n"
    "    client = redis.from_url(settings.redis_url, decode_responses=True)\n"
    "    try:\n"
    "        client.set(\n"
    "            f\"final_actionable_history_backfill:{user_id}\",\n"
    "            \"completed\",\n"
    "            ex=FINAL_ACTIONABLE_HISTORY_BACKFILL_TTL_SECONDS,\n"
    "        )\n"
    "    finally:\n"
    "        client.close()\n",
)
replace_once(
    tasks_path,
    '''            result = backfill_user_history(db, user_id=user_id)
            logger.info("Final actionable history backfill completed for user %s: %s", user_id, result)
            return result
''',
    '''            result = backfill_user_history(db, user_id=user_id)
            _mark_final_actionable_history_backfill_complete(user_id)
            logger.info("Final actionable history backfill completed for user %s: %s", user_id, result)
            return result
''',
)

# Strengthen the permanent source-level regression test.
test_path = "frontend/tests/final-actionables-history-persistence.test.mjs"
test_source = read(test_path)
test_source = test_source.replace(
    '''const routerSource = readFileSync(
  new URL("../../backend/app/domains/runs/router.py", import.meta.url),
  "utf8",
);
''',
    '''const routerSource = readFileSync(
  new URL("../../backend/app/domains/runs/router.py", import.meta.url),
  "utf8",
);
const persistenceSource = readFileSync(
  new URL("../../backend/app/domains/runs/final_actionable_history.py", import.meta.url),
  "utf8",
);
const taskSource = readFileSync(
  new URL("../../backend/app/domains/runs/tasks.py", import.meta.url),
  "utf8",
);
''',
    1,
)
test_source = test_source.replace(
    '''  assert.match(source, /getCurrentPersistableHistoryRows\\(/);
});
''',
    '''  assert.match(source, /getCurrentPersistableHistoryRows\\(/);
  assert.match(persistenceSource, /on_conflict_do_update\\(/);
  assert.match(persistenceSource, /payload_defaults = \\{/);
  assert.match(persistenceSource, /source_ids = \\{/);
  assert.match(taskSource, /FINAL_ACTIONABLE_HISTORY_BACKFILL_TTL_SECONDS = 365/);
});
''',
    1,
)
write(test_path, test_source)

(ROOT / ".github/workflows/fix-final-actionable-history-upsert.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
