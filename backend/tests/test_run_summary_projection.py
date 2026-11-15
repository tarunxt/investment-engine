from app.domains.runs.models import Run
from app.domains.runs.presentation import build_run_prompt_preview
from app.domains.runs.repository import run_summary_columns


def test_prompt_preview_is_bounded_and_normalized():
    preview = build_run_prompt_preview("  alpha\n\n" + ("beta " * 100))

    assert "\n" not in preview
    assert len(preview) <= 283
    assert preview.endswith("...")


def test_run_summary_projection_never_selects_complete_prompt():
    selected_keys = {column.key for column in run_summary_columns()}

    assert "prompt_preview" in selected_keys
    assert "prompt" not in selected_keys
    assert Run.prompt.key == "prompt"
