from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_universal_scan_does_not_share_single_planner_queue() -> None:
    celery_source = (
        ROOT / "app/infrastructure/messaging/celery_app.py"
    ).read_text(encoding="utf-8")
    task_source = (
        ROOT / "app/domains/trading_bots/tasks.py"
    ).read_text(encoding="utf-8")

    route = (
        '"app.domains.trading_bots.tasks.execute_universal_polymarket_scan": '
        '{"queue": "ai"}'
    )
    assert route in celery_source

    decorator = task_source[
        task_source.index(
            'name="app.domains.trading_bots.tasks.execute_universal_polymarket_scan"'
        ):
        task_source.index(
            "def execute_universal_polymarket_scan"
        )
    ]
    assert 'queue="ai"' in decorator
