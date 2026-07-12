import asyncio
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


def test_polygon_rpc_urls_use_env_list_without_duplicates(monkeypatch):
    monkeypatch.setenv(
        "POLYMARKET_POLYGON_RPC_URLS",
        " https://rpc-a.example , https://rpc-b.example,https://rpc-a.example ",
    )

    assert providers._polygon_rpc_urls() == [
        "https://rpc-a.example",
        "https://rpc-b.example",
    ]


def test_read_pusd_balance_falls_back_after_unauthorized_rpc(monkeypatch):
    async def run_test():
        monkeypatch.setenv(
            "POLYMARKET_POLYGON_RPC_URLS",
            "https://unauthorized.example,https://ok.example",
        )

        async def handler(request):
            import httpx
            import json

            method = json.loads(request.content.decode("utf-8"))["method"]

            if str(request.url) == "https://unauthorized.example":
                return httpx.Response(401, json={"error": "unauthorized"})
            if method == "eth_chainId":
                return httpx.Response(200, json={"result": "0x89"})
            if method == "eth_getLogs":
                return httpx.Response(200, json={"result": []})
            return httpx.Response(200, json={"result": hex(12_345_000000)})

        import httpx

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            assert await providers._read_pusd_balance(
                client, "0x1234567890abcdef1234567890ABCDEF12345678"
            ) == 12345

    asyncio.run(run_test())


def test_read_pusd_balance_returns_zero_when_all_rpc_endpoints_fail(monkeypatch):
    async def run_test():
        monkeypatch.setenv("POLYMARKET_POLYGON_RPC_URLS", "https://down.example")

        async def handler(request):
            import httpx

            return httpx.Response(401, json={"error": "unauthorized"})

        import httpx

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            assert await providers._read_pusd_balance(
                client, "0x1234567890abcdef1234567890ABCDEF12345678"
            ) == 0

    asyncio.run(run_test())


def test_read_pusd_balance_skips_wrong_chain_rpc_before_success(monkeypatch):
    async def run_test():
        monkeypatch.setenv(
            "POLYMARKET_POLYGON_RPC_URLS",
            "https://wrong-chain.example,https://ok.example",
        )

        async def handler(request):
            import httpx
            import json

            method = json.loads(request.content.decode("utf-8"))["method"]
            if str(request.url) == "https://wrong-chain.example":
                if method == "eth_chainId":
                    return httpx.Response(200, json={"result": "0x1"})
                return httpx.Response(200, json={"result": []})
            if method == "eth_chainId":
                return httpx.Response(200, json={"result": "0x89"})
            if method == "eth_getLogs":
                return httpx.Response(200, json={"result": []})
            return httpx.Response(200, json={"result": hex(9_500_000000)})

        import httpx

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            assert await providers._read_pusd_balance(
                client, "0x1234567890abcdef1234567890ABCDEF12345678"
            ) == 9500

    asyncio.run(run_test())


def test_read_pusd_balance_retries_rate_limited_rpc_with_retry_after(monkeypatch):
    async def run_test():
        monkeypatch.setenv("POLYMARKET_POLYGON_RPC_URLS", "https://limited.example")
        sleeps = []
        calls = {"eth_chainId": 0}

        async def fake_sleep(delay):
            sleeps.append(delay)

        monkeypatch.setattr(providers.asyncio, "sleep", fake_sleep)
        monkeypatch.setattr(providers.random, "random", lambda: 0.0)

        async def handler(request):
            import httpx
            import json

            method = json.loads(request.content.decode("utf-8"))["method"]
            if method == "eth_chainId":
                calls["eth_chainId"] += 1
                if calls["eth_chainId"] == 1:
                    return httpx.Response(
                        429,
                        headers={"Retry-After": "1"},
                        json={"error": "rate limited"},
                    )
                return httpx.Response(200, json={"result": "0x89"})
            if method == "eth_getLogs":
                return httpx.Response(200, json={"result": []})
            return httpx.Response(200, json={"result": hex(4_200_000000)})

        import httpx

        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            assert await providers._read_pusd_balance(
                client, "0x1234567890abcdef1234567890ABCDEF12345678"
            ) == 4200

        assert sleeps == [1.0]

    asyncio.run(run_test())
