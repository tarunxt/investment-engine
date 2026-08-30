from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

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
from app.domains.bullpen008.schemas import Bullpen008Settings
from app.domains.bullpen008.service import (
    _next_run_at,
    _seed_payload_from_007,
    stage_from_record,
)
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


def test_lightweight_stage_projection_keeps_metrics_without_raw_payloads() -> None:
    now = datetime.now(UTC)
    record = SimpleNamespace(
        stage_number=1,
        stage_name="Discover & Hard Filters",
        stage_version="bullpen008-stage1-v1",
        status="finished",
        pass_condition="accounted",
        block_reason=None,
        previous_stage_output_hash=None,
        output_hash="output",
        settings_snapshot_hash="settings",
        wallet_snapshot_hash="wallet",
        inputs_json={"market_universe": [{"market_id": "large"}]},
        calculations_json={"formula": "large"},
        outputs_json={"metrics": {"scanned": 1}, "rows": [{"market_id": "large"}]},
        rejections_json=[{"market_id": "large"}],
        warnings_json=["warning"],
        provenance_json={"source": "large"},
        prompt_version=None,
        parser_version=None,
        started_at=now,
        completed_at=now,
        duration_seconds=0,
    )
    projected = stage_from_record(record, include_payload=False)
    assert projected.outputs == {"metrics": {"scanned": 1}}
    assert projected.inputs == {}
    assert projected.rejections == []


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


def test_008_scan_bypasses_007_prefilters_without_changing_007_default() -> None:
    scanner = Path("app/domains/polymarket_auto_live/scanner.py").read_text()
    console_profile = Path(
        "app/domains/polymarket_auto_live/console_profile.py"
    ).read_text()
    task = Path("app/domains/bullpen008/tasks.py").read_text()

    assert "apply_base_filters: bool = True" in scanner
    assert "apply_base_filters: bool = True" in console_profile
    assert "use_keyset_pagination: bool = False" in scanner
    assert "use_keyset_pagination: bool = False" in console_profile
    assert "gamma_scan_timeout_seconds: float = CONSOLE_GAMMA_SCAN_TIMEOUT_SECONDS" in console_profile
    assert "apply_base_filters=False" in task
    assert "use_keyset_pagination=True" in task
    assert "gamma_scan_timeout_seconds=COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS" in task
    assert '"pre_stage1_filters_applied": False' in task
    assert '"pagination_mode": "gamma-markets-keyset"' in task
    assert '"scan_timeout_seconds": COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS' in task


def test_llm_parse_failures_retain_raw_provider_payloads_for_audit() -> None:
    source = Path("app/domains/bullpen008/tasks.py").read_text()
    assert '"raw_provider_response": raw_provider_response' in source
    assert '"raw_provider_response": raw_cluster_response' in source


def test_008_scheduler_honours_the_seeded_007_start_time() -> None:
    now = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    settings = Bullpen008Settings(
        auto_start_at="18:00:00 30 August, 2026",
        auto_refresh_minutes=360,
    )
    assert _next_run_at(settings, now=now) == datetime(
        2026, 8, 30, 12, 30, tzinfo=UTC
    )
