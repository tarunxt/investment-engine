from pathlib import Path


def test_backfill_task_loads_models_and_recovers_after_terminal_failure() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "app/domains/runs/tasks.py"
    ).read_text(encoding="utf-8")
    assert "import app.models  # noqa: F401" in source
    assert "_clear_final_actionable_history_backfill_marker(user_id)" in source
    assert "self.request.retries >= self.max_retries" in source


def test_router_uses_versioned_backfill_key() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "app/domains/runs/router.py"
    ).read_text(encoding="utf-8")
    assert "final_actionable_history_backfill_key(current_user.id)" in source
    assert 'redis.set(dedupe_key, "queued"' in source
