from pathlib import Path


RUNS_DIR = Path(__file__).resolve().parents[1] / "app" / "domains" / "runs"
TASK_SOURCE = (RUNS_DIR / "tasks.py").read_text(encoding="utf-8")
HISTORY_SOURCE = (RUNS_DIR / "final_actionable_history.py").read_text(encoding="utf-8")


def test_terminal_rebalance_queues_durable_history_reconstruction():
    assert "if is_rebalance_run(run):" in TASK_SOURCE
    assert "backfill_final_actionable_history_task.delay(run.user_id)" in TASK_SOURCE


def test_backfill_generation_is_bumped_to_repair_missing_recent_runs():
    assert "FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION = 3" in HISTORY_SOURCE
