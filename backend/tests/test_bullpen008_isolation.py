from __future__ import annotations

from pathlib import Path

from app.domains.bullpen008.constants import (
    CELERY_SCHEDULER_TASK_NAME,
    CELERY_TASK_NAME,
    REDIS_PREFIX,
    WORKFLOW_PROFILE,
)
from app.domains.bullpen008.models import (
    Bullpen008PortfolioCertificateRecord,
    Bullpen008RunRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.bullpen008.service import _seed_payload_from_007
from app.domains.bullpen008.tasks import (
    _merge_stage2_provider_rows,
    _stage2_input_rows,
    _stage2_repair_market_ids,
)


def test_008_namespaces_do_not_alias_007_resources() -> None:
    assert WORKFLOW_PROFILE == "bullpen008"
    assert REDIS_PREFIX == "bullpen008"
    assert "bullpen008" in CELERY_TASK_NAME
    assert "bullpen008" in CELERY_SCHEDULER_TASK_NAME
    assert "auto-live" not in CELERY_TASK_NAME
    assert {
        model.__tablename__
        for model in (
            Bullpen008SettingsRecord,
            Bullpen008StateRecord,
            Bullpen008RunRecord,
            Bullpen008StageOutputRecord,
            Bullpen008PortfolioCertificateRecord,
        )
    } == {
        "bullpen008_settings",
        "bullpen008_states",
        "bullpen008_runs",
        "bullpen008_stage_outputs",
        "bullpen008_portfolio_certificates",
    }


def test_one_time_seed_copies_007_console_defaults_without_aliasing_or_execution() -> (
    None
):
    source = {
        "console_min_market_odds": 7,
        "console_custom_exclude_phrases": ["Alpha"],
        "console_auto_refresh_minutes": 720,
        "console_llm_targets": [{"provider": "openai", "model": "gpt-5"}],
        "live_execution_enabled": True,
    }
    seeded = _seed_payload_from_007(source)
    source["console_custom_exclude_phrases"].append("Beta")
    source["console_auto_refresh_minutes"] = 5

    assert seeded.binary_side_odds_floor_pct == 7
    assert seeded.custom_exclude_phrases == ["alpha"]
    assert seeded.auto_refresh_minutes == 720
    assert seeded.workflow_profile == "bullpen008"
    assert seeded.shadow_mode is True
    assert seeded.execution_enabled is False


def test_stage2_targeted_repair_replaces_only_missing_or_invalid_rows() -> None:
    stage2 = {
        "missing_market_ids": ["missing"],
        "validation_errors": [
            {"market_id": "invalid", "errors": ["bad probability"]}
        ],
    }
    repair_ids = _stage2_repair_market_ids(stage2)
    assert repair_ids == ["invalid", "missing"]

    merged = _merge_stage2_provider_rows(
        [
            {"market_id": "valid", "value": 1},
            {"market_id": "invalid", "value": "old"},
        ],
        [
            {"market_id": "invalid", "value": "fixed"},
            {"market_id": "missing", "value": "supplied"},
        ],
        repair_market_ids=repair_ids,
    )
    assert merged == [
        {"market_id": "valid", "value": 1},
        {"market_id": "invalid", "value": "fixed"},
        {"market_id": "missing", "value": "supplied"},
    ]


def test_stage2_packet_contains_only_accepted_candidates_and_active_monitoring() -> None:
    rows = [
        {"market_id": "candidate", "accounting_status": "accepted"},
        {"market_id": "holding", "accounting_status": "accepted_monitoring"},
        {"market_id": "hard-filtered", "accounting_status": "rejected"},
        {"market_id": "stale", "accounting_status": "data_error"},
    ]
    assert [row["market_id"] for row in _stage2_input_rows(rows)] == [
        "candidate",
        "holding",
    ]


def test_migration_creates_only_additive_008_tables_with_profile_constraints() -> None:
    source = Path(
        "alembic/versions/f9a0b1c2d3e4_add_bullpen008_phase1_tables.py"
    ).read_text()
    assert 'down_revision: str | Sequence[str] | None = "e8f9g0h1i2j3"' in source
    for table in (
        "bullpen008_settings",
        "bullpen008_states",
        "bullpen008_runs",
        "bullpen008_stage_outputs",
        "bullpen008_portfolio_certificates",
    ):
        assert f'"{table}"' in source
    assert source.count('sa.Column("workflow_profile"') == 5
    assert "polymarket_auto_live" not in source


def test_phase1_task_never_imports_or_calls_order_submission() -> None:
    source = Path("app/domains/bullpen008/tasks.py").read_text()
    assert '"orders_created": 0' in source
    assert '"orders_submitted": 0' in source
    assert '"stage5_status": "disabled_pending_phase2"' in source
    assert '"stage6_status": "disabled_pending_phase2"' in source
    assert "execute_order" not in source
    assert "submit_order" not in source
    assert "create_order_intent" not in source
