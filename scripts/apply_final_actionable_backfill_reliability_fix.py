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
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


# Centralize and version the Redis completion marker so old, prematurely completed
# markers cannot suppress a corrected backfill forever.
replace_once(
    "backend/app/domains/runs/final_actionable_history.py",
    'ACTION_PRIORITY = ["Sell All", "Trim", "Hold", "Add more", "Buy New"]\n',
    'ACTION_PRIORITY = ["Sell All", "Trim", "Hold", "Add more", "Buy New"]\n'
    'FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION = 2\n\n\n'
    'def final_actionable_history_backfill_key(user_id: int) -> str:\n'
    '    return (\n'
    '        f"final_actionable_history_backfill:v"\n'
    '        f"{FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION}:{user_id}"\n'
    '    )\n',
)

replace_once(
    "backend/app/domains/runs/tasks.py",
    "from app.domains.runs.final_actionable_history import backfill_user_history\n",
    "from app.domains.runs.final_actionable_history import (\n"
    "    backfill_user_history,\n"
    "    final_actionable_history_backfill_key,\n"
    ")\n",
)
replace_once(
    "backend/app/domains/runs/tasks.py",
    '            f"final_actionable_history_backfill:{user_id}",\n',
    "            final_actionable_history_backfill_key(user_id),\n",
)
replace_once(
    "backend/app/domains/runs/tasks.py",
    "\n\ndef _status_value(status: object) -> str:\n",
    "\n\ndef _clear_final_actionable_history_backfill_marker(user_id: int) -> None:\n"
    "    client = redis.from_url(settings.redis_url, decode_responses=True)\n"
    "    try:\n"
    "        client.delete(final_actionable_history_backfill_key(user_id))\n"
    "    finally:\n"
    "        client.close()\n"
    "\n\ndef _status_value(status: object) -> str:\n",
)
replace_once(
    "backend/app/domains/runs/tasks.py",
    "def backfill_final_actionable_history_task(self, user_id: int) -> dict[str, int]:\n"
    "    with SyncSessionLocal() as db:\n",
    "def backfill_final_actionable_history_task(self, user_id: int) -> dict[str, int]:\n"
    "    # Celery imports task modules without necessarily importing every domain\n"
    "    # model. Register the complete SQLAlchemy mapper graph before querying.\n"
    "    import app.models  # noqa: F401\n"
    "\n"
    "    with SyncSessionLocal() as db:\n",
)
replace_once(
    "backend/app/domains/runs/tasks.py",
    "        except Exception as exc:\n"
    "            db.rollback()\n"
    "            logger.exception(\"Final actionable history backfill failed for user %s\", user_id)\n"
    "            raise self.retry(exc=exc)\n",
    "        except Exception as exc:\n"
    "            db.rollback()\n"
    "            logger.exception(\"Final actionable history backfill failed for user %s\", user_id)\n"
    "            if self.request.retries >= self.max_retries:\n"
    "                _clear_final_actionable_history_backfill_marker(user_id)\n"
    "            raise self.retry(exc=exc)\n",
)

replace_once(
    "backend/app/domains/runs/router.py",
    "from app.domains.runs.final_actionable_history import (\n"
    "    list_stock_history,\n"
    "    persist_history_items,\n"
    ")\n",
    "from app.domains.runs.final_actionable_history import (\n"
    "    final_actionable_history_backfill_key,\n"
    "    list_stock_history,\n"
    "    persist_history_items,\n"
    ")\n",
)
replace_once(
    "backend/app/domains/runs/router.py",
    '    dedupe_key = f"final_actionable_history_backfill:{current_user.id}"\n',
    "    dedupe_key = final_actionable_history_backfill_key(current_user.id)\n",
)
replace_once(
    "backend/app/domains/runs/router.py",
    '        queued = await redis.set(dedupe_key, "1", nx=True, ex=60 * 60)\n',
    '        queued = await redis.set(dedupe_key, "queued", nx=True, ex=60 * 60)\n',
)

# Regression tests: the task must initialize all mappers, use a versioned key,
# and clear a terminally failed marker so the next dashboard load can retry.
test_path = "backend/tests/test_final_actionable_history_parser.py"
test_content = read(test_path)
append = '''\n\ndef test_backfill_marker_is_versioned() -> None:\n    from app.domains.runs.final_actionable_history import (\n        FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION,\n        final_actionable_history_backfill_key,\n    )\n\n    assert FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION >= 2\n    assert final_actionable_history_backfill_key(7).endswith(\":7\")\n    assert \"final_actionable_history_backfill:v\" in final_actionable_history_backfill_key(7)\n'''
if "def test_backfill_marker_is_versioned" not in test_content:
    write(test_path, test_content + append)

# Source-contract checks catch regressions that unit tests cannot exercise without
# Redis/Celery and the full production mapper registry.
contract_path = ROOT / "backend/tests/test_final_actionable_history_task_contract.py"
contract_path.write_text(
    '''from pathlib import Path\n\n\ndef test_backfill_task_loads_models_and_recovers_after_terminal_failure() -> None:\n    source = (\n        Path(__file__).resolve().parents[1]\n        / \"app/domains/runs/tasks.py\"\n    ).read_text(encoding=\"utf-8\")\n    assert \"import app.models  # noqa: F401\" in source\n    assert \"_clear_final_actionable_history_backfill_marker(user_id)\" in source\n    assert \"self.request.retries >= self.max_retries\" in source\n\n\ndef test_router_uses_versioned_backfill_key() -> None:\n    source = (\n        Path(__file__).resolve().parents[1]\n        / \"app/domains/runs/router.py\"\n    ).read_text(encoding=\"utf-8\")\n    assert \"final_actionable_history_backfill_key(current_user.id)\" in source\n    assert 'redis.set(dedupe_key, \"queued\"' in source\n''',
    encoding="utf-8",
)

# Remove the one-shot patcher after it has materialized the real implementation.
Path(__file__).unlink(missing_ok=True)
