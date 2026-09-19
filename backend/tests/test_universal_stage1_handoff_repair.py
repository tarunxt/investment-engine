from __future__ import annotations

from types import SimpleNamespace

from app.domains.trading_bots.tasks import _workflow_run_completed_stage1


def test_workflow_handoff_requires_completed_stage1() -> None:
    failed_before_stage1 = SimpleNamespace(
        payload={
            "stage_results": [
                {
                    "stage_number": 1,
                    "outputs": {"workflow_stage_key": "scan"},
                    "completed_at": None,
                }
            ]
        }
    )
    assert not _workflow_run_completed_stage1(failed_before_stage1)


def test_workflow_handoff_accepts_completed_stage1() -> None:
    completed = SimpleNamespace(
        payload={
            "stage_results": [
                {
                    "stage_number": 1,
                    "outputs": {"workflow_stage_key": "scan"},
                    "completed_at": "2026-09-19T04:00:00+00:00",
                }
            ]
        }
    )
    assert _workflow_run_completed_stage1(completed)


def test_universal_state_preserves_repair_batch_identity() -> None:
    from app.domains.trading_bots.universal_scan import read_state

    record = SimpleNamespace(
        payload={
            "universal_scan_auto_run": {
                "workflow_trigger_export_id": "export-1",
                "workflow_trigger_batch_id": "export-1-repair-123",
            }
        }
    )
    state = read_state(record)
    assert state["workflow_trigger_batch_id"] == "export-1-repair-123"


def test_universal_export_default_is_shared_across_service_homes(monkeypatch) -> None:
    from app.domains.trading_bots.universal_scan import (
        _readable_export_directories,
        export_directory,
    )

    monkeypatch.delenv("BULLPEN_STAGE_ONE_EXPORT_DIRECTORY", raising=False)
    primary = export_directory()
    assert primary.name == ".stage-one-exports"
    assert primary.parent.name == "backend"

    readable = _readable_export_directories()
    assert readable[0] == primary
    assert any(
        str(path).endswith(".local/share/credx-bullpen-stage-one-exports")
        for path in readable[1:]
    )
