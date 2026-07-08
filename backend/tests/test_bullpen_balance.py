import os
from datetime import datetime, timezone

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import bullpen


def test_missing_balance_command_does_not_mask_missing_cli_executable():
    message = (
        "All Bullpen command variants failed: portfolio balances => "
        "Bullpen CLI executable was not found. Install Bullpen in the backend runtime."
    )

    assert bullpen._is_missing_balance_command(message) is False


def test_missing_balance_command_detects_subcommand_errors():
    message = (
        "All Bullpen command variants failed: portfolio balances => "
        "error: unrecognized subcommand 'balances'"
    )

    assert bullpen._is_missing_balance_command(message) is True


def test_format_balance_error_message_summarizes_auth_required_json():
    message = (
        "All Bullpen command variants failed: portfolio balances => "
        '{"error":"not logged in. Run: bullpen login","error_code":"AUTH_REQUIRED",'
        '"requires_auth":true,"requires_login":true,"status":"error"} | '
        "funds balances => Auth reauthentication required"
    )

    assert (
        bullpen._format_balance_error_message(message)
        == "Balance unavailable: Bullpen login required. Run: bullpen login"
    )


def test_format_balance_error_message_preserves_missing_cli_executable_detail():
    message = (
        "All Bullpen command variants failed: portfolio balances => "
        "Bullpen CLI executable was not found. Install Bullpen in the backend runtime."
    )

    assert (
        bullpen._format_balance_error_message(message)
        == f"Balance unavailable: {message}"
    )


def test_format_balance_message_prefers_polymarket_available_pusd():
    parsed = {
        "data": {
            "chains": [
                {
                    "platform": "Solana",
                    "tokens": [{"symbol": "USDC", "balance": "25.00"}],
                },
                {
                    "platform": "Polymarket",
                    "tokens": [{"symbol": "pUSD", "balance": "432.1100"}],
                },
            ]
        }
    }

    assert (
        bullpen._format_balance_message(parsed)
        == "Polymarket available balance: 432.11 pUSD"
    )


def test_format_balance_message_prefers_bullpen_account_value_over_cash():
    parsed = {
        "account": "Bullpen",
        "account_value": "$8.03",
        "cash": "0.61",
        "currency": "USD",
    }

    assert bullpen._format_balance_message(parsed) == "Bullpen account value: 8.03 USD"


def test_format_balance_message_treats_total_balance_as_account_value():
    parsed = {
        "account": "Bullpen",
        "totalBalance": "$8.03",
        "cash": "0.61",
        "currency": "USD",
    }

    assert bullpen._format_balance_message(parsed) == "Bullpen account value: 8.03 USD"


def test_balance_reader_returns_account_and_available_values():
    parsed = {
        "account": "Bullpen",
        "account_value": "$114.07",
        "cash": "97.48",
        "currency": "USD",
    }

    values = bullpen._extract_balance_values(parsed)

    assert values["account_value_usd"] == 114.07
    assert values["available_balance_usd"] == 97.48


def test_bullpen_executable_uses_runtime_tools_when_env_path_missing(
    monkeypatch, tmp_path
):
    runtime_tools = tmp_path / ".runtime-tools"
    runtime_tools.mkdir()
    fallback = runtime_tools / "bullpen"
    fallback.write_text("#!/usr/bin/env sh\necho bullpen\n")
    fallback.chmod(0o755)

    monkeypatch.setenv("BULLPEN_BIN", str(tmp_path / "missing-bullpen"))
    monkeypatch.chdir(tmp_path)

    assert bullpen.bullpen_executable() == str(fallback)


def test_bullpen_executable_prefers_executable_env_path(monkeypatch, tmp_path):
    configured = tmp_path / "configured-bullpen"
    configured.write_text("#!/usr/bin/env sh\necho bullpen\n")
    configured.chmod(0o755)

    monkeypatch.setenv("BULLPEN_BIN", str(configured))

    assert bullpen.bullpen_executable() == str(configured)


def test_bullpen_executable_uses_non_dot_runtime_tools(monkeypatch, tmp_path):
    runtime_tools = tmp_path / "runtime-tools"
    runtime_tools.mkdir()
    fallback = runtime_tools / "bullpen"
    fallback.write_text("#!/usr/bin/env sh\necho bullpen\n")
    fallback.chmod(0o755)

    monkeypatch.delenv("BULLPEN_BIN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert bullpen.bullpen_executable() == str(fallback)


def test_bullpen_candidate_paths_include_systemd_and_home_locations(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("BULLPEN_BIN", "/custom/bin/bullpen")
    monkeypatch.setenv("APP_ROOT", str(tmp_path / "app"))
    monkeypatch.setenv("BACKEND_ROOT", str(tmp_path / "backend"))

    candidates = bullpen.bullpen_candidate_paths()

    assert candidates[0] == "/custom/bin/bullpen"
    assert str(tmp_path / "app" / ".runtime-tools" / "bullpen") in candidates
    assert str(tmp_path / "backend" / "runtime-tools" / "bullpen") in candidates
    assert "/home/investment-engine/.bullpen/bin/bullpen" in candidates
    assert "/home/investor/.bullpen/bin/bullpen" in candidates
    assert "/opt/homebrew/bin/bullpen" in candidates
    assert "/usr/local/bin/bullpen" in candidates


def test_balance_reader_returns_exact_bullpen_wallet_values():
    parsed = {
        "account": "Bullpen",
        "account_value": "$83.36",
        "cash": "17.04",
        "pnl": "$5.57",
        "uPNL": "-2.87",
        "currency": "USD",
    }

    values = bullpen._extract_balance_values(parsed)

    assert values["account_value_usd"] == 83.36
    assert values["available_balance_usd"] == 17.04
    assert values["pnl_usd"] == 5.57
    assert values["upnl_usd"] == -2.87


def test_bullpen_process_env_uses_service_home_when_home_is_root(monkeypatch):
    monkeypatch.setenv("HOME", "/root")
    monkeypatch.delenv("BULLPEN_HOME", raising=False)
    monkeypatch.delenv("BULLPEN_CREDENTIALS_HOME", raising=False)
    monkeypatch.setattr(bullpen.os, "getuid", lambda: 1234)

    class UserInfo:
        pw_dir = "/home/investment-engine"

    monkeypatch.setattr(bullpen.pwd, "getpwuid", lambda uid: UserInfo())

    env = bullpen.bullpen_process_env(read_only=True)

    assert env["HOME"] == "/home/investment-engine"
    assert env["BULLPEN_READ_ONLY"] == "true"
    assert env["BULLPEN_NON_INTERACTIVE"] == "true"


def test_bullpen_process_env_allows_explicit_credentials_home(monkeypatch):
    monkeypatch.setenv("HOME", "/root")
    monkeypatch.setenv("BULLPEN_CREDENTIALS_HOME", "/srv/bullpen")

    env = bullpen.bullpen_process_env(read_only=False)

    assert env["HOME"] == "/srv/bullpen"
    assert "BULLPEN_READ_ONLY" not in env
    assert "BULLPEN_NON_INTERACTIVE" not in env


@pytest.mark.anyio
async def test_run_first_bullpen_json_includes_runtime_context_in_failure(monkeypatch):
    async def fake_run_bullpen_json(args, *, timeout_seconds=20):
        raise bullpen.BullpenCommandError("not logged in. Run: bullpen login")

    monkeypatch.setattr(bullpen, "run_bullpen_json", fake_run_bullpen_json)
    monkeypatch.setattr(
        bullpen,
        "bullpen_runtime_context",
        lambda *, read_only: {
            "credential_home": "/home/investor",
            "command_path": "/usr/local/bin/bullpen",
        },
    )

    with pytest.raises(bullpen.BullpenCommandError) as exc_info:
        await bullpen.run_first_bullpen_json(
            [["polymarket", "positions", "--output", "json"]]
        )

    assert "HOME=/home/investor" in str(exc_info.value)
    assert "CLI=/usr/local/bin/bullpen" in str(exc_info.value)
    assert "not logged in. Run: bullpen login" in str(exc_info.value)


def test_parse_bullpen_session_extracts_15_minute_jwt_window():
    from datetime import datetime, timezone

    status_output = """
Account
  Status:           Logged in
  JWT expires:      2026-06-14 16:53:20 UTC (in 13m 45s)
  JWT observed:     2026-06-14 16:38:23 UTC; client expires in 14m 57s
"""

    session = bullpen.parse_bullpen_session(
        status_output, now=datetime(2026, 6, 14, 16, 38, 23, tzinfo=timezone.utc)
    )

    assert session == {
        "bullpen_login_observed_at": "2026-06-14T16:38:23+00:00",
        "bullpen_jwt_expires_at": "2026-06-14T16:53:20+00:00",
        "bullpen_jwt_seconds_remaining": 897,
    }


@pytest.mark.anyio
async def test_bullpen_doctor_accepts_active_status_when_preflight_has_stale_refresh_token(monkeypatch):
    status_output = """
Account
  Status:           Logged in
  JWT expires:      2026-06-14 17:39:06 UTC (in 13m 48s)
  JWT observed:     2026-06-14 17:24:08 UTC; client expires in 14m 58s
"""

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        if args == ["status"]:
            return status_output
        if args == ["polymarket", "preflight"]:
            raise bullpen.BullpenCommandError(
                "Session expired. Run: bullpen login Caused by: Refresh token rejected "
                "(Unauthenticated: Unauthenticated: Invalid refresh token)."
            )
        raise AssertionError(f"unexpected args: {args}")

    monkeypatch.setattr(bullpen, "run_bullpen", fake_run_bullpen)
    monkeypatch.setattr(
        bullpen,
        "datetime",
        type(
            "FrozenDateTime",
            (),
            {
                "now": staticmethod(
                    lambda tz=None: datetime(2026, 6, 14, 17, 25, 0, tzinfo=timezone.utc)
                ),
                "strptime": staticmethod(datetime.strptime),
            },
        ),
    )

    doctor = await bullpen.BullpenLiveExecutor().doctor()

    assert doctor.ok is True
    assert "active JWT" in doctor.message
    assert doctor.bullpen_jwt_seconds_remaining == 846


@pytest.mark.anyio
async def test_bullpen_doctor_accepts_active_status_when_preflight_has_transient_transport_error(monkeypatch):
    status_output = """
Account
  Status:           Logged in
  JWT expires:      2026-06-14 17:39:06 UTC (in 13m 48s)
  JWT observed:     2026-06-14 17:24:08 UTC; client expires in 14m 58s
"""

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        if args == ["status"]:
            return status_output
        if args == ["polymarket", "preflight"]:
            raise bullpen.BullpenCommandError(
                "failed to validate active wallet role before money-path routing for owner "
                "0xabc caused by: failed to fetch wallets: protocol error: received "
                "message with invalid compression flag; 101 (valid flags are 0 and 1) "
                "failed: 502 Bad Gateway"
            )
        raise AssertionError(f"unexpected args: {args}")

    monkeypatch.setattr(bullpen, "run_bullpen", fake_run_bullpen)
    monkeypatch.setattr(
        bullpen,
        "datetime",
        type(
            "FrozenDateTime",
            (),
            {
                "now": staticmethod(
                    lambda tz=None: datetime(2026, 6, 14, 17, 25, 0, tzinfo=timezone.utc)
                ),
                "strptime": staticmethod(datetime.strptime),
            },
        ),
    )

    doctor = await bullpen.BullpenLiveExecutor().doctor()

    assert doctor.ok is True
    assert "transient transport error" in doctor.message
    assert doctor.bullpen_jwt_seconds_remaining == 846


@pytest.mark.anyio
async def test_bullpen_doctor_still_fails_stale_refresh_token_without_active_jwt(monkeypatch):
    status_output = """
Account
  Status:           Logged in
  JWT expires:      2026-06-14 17:20:00 UTC (in 0s)
  JWT observed:     2026-06-14 17:05:00 UTC; client expires in 0s
"""

    async def fake_run_bullpen(args, *, timeout_seconds, read_only):
        if args == ["status"]:
            return status_output
        if args == ["polymarket", "preflight"]:
            raise bullpen.BullpenCommandError("Refresh token rejected: Invalid refresh token")
        raise AssertionError(f"unexpected args: {args}")

    monkeypatch.setattr(bullpen, "run_bullpen", fake_run_bullpen)
    monkeypatch.setattr(
        bullpen,
        "datetime",
        type(
            "FrozenDateTime",
            (),
            {
                "now": staticmethod(
                    lambda tz=None: datetime(2026, 6, 14, 17, 25, 0, tzinfo=timezone.utc)
                ),
                "strptime": staticmethod(datetime.strptime),
            },
        ),
    )

    doctor = await bullpen.BullpenLiveExecutor().doctor()

    assert doctor.ok is False
    assert "Bullpen doctor failed" in doctor.message
