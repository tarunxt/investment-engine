import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket import providers


def test_extract_positions_value_from_data_api_list():
    assert providers._extract_positions_value([{"value": "161.35"}]) == 161.35


def test_sum_redeemable_value_uses_only_claimable_positions():
    positions = [
        {"title": "open", "currentValue": "75.25", "redeemable": False},
        {"title": "won", "currentValue": "12.50", "redeemable": True},
        {"title": "claim", "claimableValue": "7.75", "claimable": True},
    ]

    assert providers._sum_redeemable_value(positions) == 20.25


def test_erc20_balance_of_calldata_encodes_wallet_address():
    wallet = "0x1234567890abcdef1234567890ABCDEF12345678"

    assert providers._erc20_balance_of_calldata(wallet) == (
        "0x70a08231"
        "000000000000000000000000"
        "1234567890abcdef1234567890abcdef12345678"
    )
