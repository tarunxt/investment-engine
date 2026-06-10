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
