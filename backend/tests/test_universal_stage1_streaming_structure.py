from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONSOLE_PROFILE = ROOT / "app/domains/polymarket_auto_live/console_profile.py"
ENGINE = ROOT / "app/domains/polymarket_auto_live/engine.py"


def test_console_profile_streams_externalized_universal_rejections() -> None:
    source = CONSOLE_PROFILE.read_text(encoding="utf-8")
    ast.parse(source)

    assert "serialized_rejected: list[dict[str, object]] | None = None" in source
    assert "serialized = rejected_callback(rejected_market)" in source
    assert "serialized_rejected.append(serialized)" in source

    universal_branch = source[source.index("if universal_scan_user_id is not None:"):]
    assert universal_branch.index("if rejected_callback is None:") < universal_branch.index(
        "rejected.append(rejected_market)"
    )
    assert "serialized_rejected=serialized_rejected" in universal_branch


def test_engine_reuses_streamed_rejections_and_bounds_diagnostics() -> None:
    source = ENGINE.read_text(encoding="utf-8")
    ast.parse(source)

    assert "stage1_rejected_candidates = scanned.serialized_rejected" in source
    assert "stage1_rejected_candidates[:1_000]" in source
    assert "return serialized" in source
