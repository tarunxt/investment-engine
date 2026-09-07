"""Minimal, read-only Stage 1 input for the workbook worker."""
from types import SimpleNamespace


def build_export_snapshot(stages, started_at, completed_at):
    def timestamp(value):
        return value.isoformat() if hasattr(value, 'isoformat') else value

    return SimpleNamespace(
        started_at=timestamp(started_at), completed_at=timestamp(completed_at),
        stage_results=[SimpleNamespace(stage_number=stage.get('stage_number'),
                                       outputs=stage.get('outputs') or {})
                       for stage in (stages or []) if isinstance(stage, dict)],
    )
