from pathlib import Path


ENGINE_SOURCE = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "domains"
    / "polymarket_auto_live"
    / "engine.py"
).read_text()


def test_non_timeout_wallet_failure_keeps_candidate_only_stage2_available():
    assert "if not _is_stage1_wallet_handoff_timeout(exc):" not in ENGINE_SOURCE
    assert (
        "Stage 1 failed because Cred-X could not refresh fresh Bullpen wallet positions"
        not in ENGINE_SOURCE
    )
    assert "recovered_snapshot = await recover_stage1_wallet_snapshot(recovery_trigger)" in ENGINE_SOURCE
    assert "Stage 2 will review " in ENGINE_SOURCE
    assert "new candidates only; Stage 3 remains blocked." in ENGINE_SOURCE
    assert '"stage2_candidate_only": bool(stage1_wallet_refresh_error)' in ENGINE_SOURCE
    assert '"blocked_by_stage1_wallet_refresh": True' in ENGINE_SOURCE


def test_wallet_failure_recovery_preserves_timeout_and_auth_classification():
    assert '"transient-timeout"' in ENGINE_SOURCE
    assert "wallet-refresh-{failure_classification or 'error'}" in ENGINE_SOURCE
