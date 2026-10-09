"""Manual protected orders work while background financial writes stay denied."""
import asyncio
import os
import unittest
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/testdb")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from app.core.config import settings
from app.core.recovery import (
    RecoveryBlocked, RecoveryMiddleware, manual_zerodha_order_scope,
    recovery_http_allowed, require_bullpen_command_allowed,
    require_financial_writes_allowed, require_task_allowed,
)
from app.domains.zerodha.service import ZerodhaService

ORDER = dict(tradingsymbol="TEST", exchange="NSE", transaction_type="SELL",
             quantity="1", product="CNC", validity="DAY", order_type="MARKET",
             market_protection="-1")


class ManualRecoveryTest(unittest.TestCase):
    def setUp(self):
        for patcher in (
            patch.dict(os.environ, {"CREDX_RECOVERY_MODE": "1"}),
            patch.object(settings, "zerodha_recovery_manual_orders_enabled", True),
            patch.object(settings, "zerodha_enable_direct_market_orders", True),
            patch.object(settings, "zerodha_api_key", "fixture"),
            patch.object(settings, "zerodha_api_secret", "fixture"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.svc = ZerodhaService()
        self.requests = []
        def respond(request):
            self.requests.append(request)
            return httpx.Response(200, json={"status": "success", "data": {"order_id": "fake-1"}})
        client = httpx.AsyncClient
        self.transport = patch("app.domains.zerodha.service.httpx.AsyncClient",
                               side_effect=lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
        self.transport.start()
        self.addCleanup(self.transport.stop)

    def test_scoped_manual_order_reaches_mock_broker_and_scope_is_reset(self):
        self.assertTrue(self.svc.direct_market_orders_enabled)
        self.assertIsNone(self.svc.order_submission_blocked_reason)
        async def run():
            with manual_zerodha_order_scope():
                self.assertEqual(await self.svc.place_order("fake", ORDER), {"order_id": "fake-1"})
            with self.assertRaises(RecoveryBlocked):
                await self.svc.place_order("fake", ORDER)
        asyncio.run(run())
        self.assertEqual(len(self.requests), 1)
        self.assertIn(b"market_protection=-1", self.requests[0].content)

    def test_exception_does_not_enable_background_trading_or_other_mutations(self):
        with manual_zerodha_order_scope():
            for action in (require_financial_writes_allowed,
                           lambda: require_bullpen_command_allowed(["buy"]),
                           lambda: require_task_allowed("execute_auto_live_order_intent")):
                with self.assertRaises(RecoveryBlocked):
                    action()
            for overrides in ({"market_protection": "0"}, {"market_protection": "NaN"},
                              {"product": "MIS"}, {"exchange": "NFO"}, {"order_type": "LIMIT"}):
                with self.assertRaises(RecoveryBlocked):
                    asyncio.run(self.svc.place_order("fake", {**ORDER, **overrides}))
            with self.assertRaises(RecoveryBlocked):
                asyncio.run(self.svc._request_async("DELETE", "/orders/regular/1"))
        self.assertEqual(self.requests, [])

    def test_opt_out_revokes_both_discovery_and_scoped_transport(self):
        with patch.object(settings, "zerodha_recovery_manual_orders_enabled", False):
            self.assertFalse(self.svc.direct_market_orders_enabled)
            self.assertIn("recovery", self.svc.order_submission_blocked_reason)
            self.assertFalse(recovery_http_allowed("POST", "/zerodha/orders/place-protected-market-sequenced"))
            with manual_zerodha_order_scope(), self.assertRaises(RecoveryBlocked):
                asyncio.run(self.svc.place_order("fake", ORDER))
        self.assertFalse(self.requests)

    def test_only_exact_manual_endpoints_and_order_book_are_allowed(self):
        for path in ("/zerodha/orders/place-protected-market", "/zerodha/orders/place-protected-market-sequenced"):
            self.assertTrue(recovery_http_allowed("POST", path))
            self.assertFalse(recovery_http_allowed("DELETE", path))
            self.assertFalse(recovery_http_allowed("POST", path + "/other"))
        self.assertTrue(recovery_http_allowed("GET", "/zerodha/orders"))
        for path in ("/zerodha/orders", "/polymarket/auto-live/run-once", "/polymarket-direct/orders"):
            self.assertFalse(recovery_http_allowed("POST", path))

    def test_real_sequenced_route_submits_only_the_explicit_manual_sell(self):
        from app.domains.zerodha import router as routes
        app = FastAPI()
        app.add_middleware(RecoveryMiddleware)
        app.include_router(routes.router)
        db = SimpleNamespace(commit=AsyncMock())
        async def session():
            yield db
        app.dependency_overrides[routes.get_async_db] = session
        app.dependency_overrides[routes.get_current_user] = lambda: SimpleNamespace(id=123)
        with patch.object(routes, "_svc", self.svc), patch.object(
            routes, "ZerodhaCredentialRepository",
            return_value=SimpleNamespace(get_plaintext_token=AsyncMock(return_value="fake")),
        ), patch.object(routes, "ZerodhaAuditRepository", return_value=SimpleNamespace(log=AsyncMock())):
            with TestClient(app) as client:
                response = client.post("/zerodha/orders/place-protected-market-sequenced", json={"orders": [ORDER]})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["placed_count"], 1)
                self.assertEqual(response.json()["sell_results"][0]["order_id"], "fake-1")
                self.assertFalse(response.json()["buy_phase_attempted"])
                self.assertEqual(client.post("/zerodha/orders", json=ORDER).status_code, 503)
        self.assertEqual(len(self.requests), 1)
        with self.assertRaises(RecoveryBlocked):
            asyncio.run(self.svc.place_order("fake", ORDER))

    def test_middleware_preserves_authentication_boundary(self):
        app = FastAPI()
        app.add_middleware(RecoveryMiddleware)
        def authenticate():
            raise HTTPException(401, "Authentication required")
        @app.post("/zerodha/orders/place-protected-market-sequenced")
        def protected(user=Depends(authenticate)):
            self.fail("Unauthenticated request entered the order handler")
        with TestClient(app) as client:
            self.assertEqual(client.post("/zerodha/orders/place-protected-market-sequenced", json={}).status_code, 401)
            self.assertEqual(client.post("/zerodha/orders", json={}).status_code, 503)
        self.assertFalse(self.requests)


if __name__ == "__main__":
    unittest.main()
