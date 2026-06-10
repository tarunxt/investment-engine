import os

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


def test_bullpen_executable_uses_runtime_tools_when_env_path_missing(monkeypatch, tmp_path):
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


def test_bullpen_candidate_paths_include_systemd_and_home_locations(monkeypatch, tmp_path):
    monkeypatch.setenv("BULLPEN_BIN", "/custom/bin/bullpen")
    monkeypatch.setenv("APP_ROOT", str(tmp_path / "app"))
    monkeypatch.setenv("BACKEND_ROOT", str(tmp_path / "backend"))

    candidates = bullpen.bullpen_candidate_paths()

    assert candidates[0] == "/custom/bin/bullpen"
    assert str(tmp_path / "app" / ".runtime-tools" / "bullpen") in candidates
    assert str(tmp_path / "backend" / "runtime-tools" / "bullpen") in candidates
    assert "/home/investor/.bullpen/bin/bullpen" in candidates
    assert "/usr/local/bin/bullpen" in candidates
