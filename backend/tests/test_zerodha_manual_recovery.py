"""Recovery route scope never replaces module or connection authorization.

Stage07 closed unbound public adapter calls. Stage09 additionally requires an
explicit app/session binding instead of environment credential fallback. These
contracts exercise both denials without weakening either guard for a legacy test.
"""
import asyncio
import os
import unittest
from unittest.mock import patch, AsyncMock
from datetime import datetime, timedelta, timezone
from pydantic import SecretStr
from app.domains.connections.material import AppMaterial, BoundToken
from app.domains.connections.crypto import ConnectionFault
from app.domains.modules.lifecycle import ModuleLifecycleDenied
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
    require_financial_writes_allowed, require_task_allowed, require_zerodha_write_allowed,
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
        # Explicit fake material is necessary for configuration discovery; it is
        # not module authorization and never consults a live credential service.
        app = AppMaterial(SecretStr("fixture-key"), SecretStr("fixture-secret"), "fake", 1)
        self.svc = ZerodhaService(app)
        self.token = BoundToken(123, "fake-connection", 1, app, SecretStr("fixture-token"),
                                datetime.now(timezone.utc) + timedelta(hours=1))
        self.requests = []
        def respond(request):
            self.requests.append(request)
            return httpx.Response(200, json={"status": "success", "data": {"order_id": "fake-1"}})
        client = httpx.AsyncClient
        self.transport = patch("app.domains.zerodha.service.httpx.AsyncClient",
                               side_effect=lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
        self.transport.start()
        self.addCleanup(self.transport.stop)

    def test_scoped_manual_order_requires_execution_authority_and_scope_is_reset(self):
        self.assertTrue(self.svc.direct_market_orders_enabled)
        self.assertIsNone(self.svc.order_submission_blocked_reason)
        with manual_zerodha_order_scope():
            # The narrow recovery validator accepts only this order shape. It
            # cannot confer authority on the public guarded adapter.
            require_zerodha_write_allowed("POST", "/orders/regular", ORDER)
            with self.assertRaisesRegex(ModuleLifecycleDenied, "Trusted module execution context required"):
                asyncio.run(self.svc.place_order(self.token, ORDER))
        with self.assertRaises(RecoveryBlocked):
            require_zerodha_write_allowed("POST", "/orders/regular", ORDER)
        with self.assertRaises(ModuleLifecycleDenied):
            asyncio.run(self.svc.place_order(self.token, ORDER))
        self.assertEqual(self.requests, [])

    def test_explicit_app_binding_is_required_despite_global_settings(self):
        unbound = ZerodhaService()
        # setUp deliberately supplies fake global settings too. They must not
        # silently become an application's or user's credential binding.
        self.assertFalse(unbound.is_configured)
        self.assertFalse(unbound.direct_market_orders_enabled)
        with self.assertRaisesRegex(ConnectionFault, "CONNECTION_APP_BINDING_REQUIRED"):
            unbound.get_login_url()
        with self.assertRaisesRegex(ConnectionFault, "CONNECTION_BOUND_TOKEN_REQUIRED"):
            self.svc._auth_headers("fixture-token")
        self.assertEqual(self.requests, [])

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
                    require_zerodha_write_allowed("POST", "/orders/regular", {**ORDER, **overrides})
                with self.assertRaises(ModuleLifecycleDenied):
                    asyncio.run(self.svc.place_order(self.token, {**ORDER, **overrides}))
            with self.assertRaises(RecoveryBlocked):
                asyncio.run(self.svc._request_async("DELETE", "/orders/regular/1"))
        self.assertEqual(self.requests, [])

    def test_opt_out_revokes_both_discovery_and_scoped_transport(self):
        with patch.object(settings, "zerodha_recovery_manual_orders_enabled", False):
            self.assertFalse(self.svc.direct_market_orders_enabled)
            self.assertIn("recovery", self.svc.order_submission_blocked_reason)
            self.assertFalse(recovery_http_allowed("POST", "/zerodha/orders/place-protected-market-sequenced"))
            with manual_zerodha_order_scope():
                with self.assertRaises(RecoveryBlocked):
                    require_zerodha_write_allowed("POST", "/orders/regular", ORDER)
                with self.assertRaises(ModuleLifecycleDenied):
                    asyncio.run(self.svc.place_order(self.token, ORDER))
        self.assertFalse(self.requests)

    def test_only_exact_manual_endpoints_and_order_book_are_allowed(self):
        for path in ("/zerodha/orders/place-protected-market", "/zerodha/orders/place-protected-market-sequenced"):
            self.assertTrue(recovery_http_allowed("POST", path))
            self.assertFalse(recovery_http_allowed("DELETE", path))
            self.assertFalse(recovery_http_allowed("POST", path + "/other"))
        self.assertTrue(recovery_http_allowed("GET", "/zerodha/orders"))
        for path in ("/zerodha/orders", "/polymarket/auto-live/run-once", "/polymarket-direct/orders"):
            self.assertFalse(recovery_http_allowed("POST", path))

    def test_real_sequenced_route_cannot_submit_without_execution_authority(self):
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
            return_value=SimpleNamespace(get_plaintext_token=AsyncMock(return_value=self.token)),
        ), patch.object(routes, "ZerodhaAuditRepository", return_value=SimpleNamespace(log=AsyncMock())):
            with TestClient(app) as client:
                # Unbound discovery fails before session lookup, even though
                # global fake app settings and the recovery flag are present.
                with patch.object(routes, "_svc", ZerodhaService()):
                    self.assertEqual(client.post("/zerodha/orders/place-protected-market-sequenced",
                                                 json={"orders": [ORDER]}).status_code, 503)
                with self.assertLogs("app.domains.zerodha.router", level="ERROR") as captured:
                    response = client.post("/zerodha/orders/place-protected-market-sequenced", json={"orders": [ORDER]})
                self.assertIn("Trusted module execution context required", "\n".join(captured.output))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["placed_count"], 0)
                self.assertEqual(response.json()["failed_count"], 1)
                self.assertEqual(response.json()["sell_results"][0]["status"], "failed")
                self.assertFalse(response.json()["sell_results"][0].get("order_id"))
                self.assertFalse(response.json()["buy_phase_attempted"])
                self.assertEqual(client.post("/zerodha/orders", json=ORDER).status_code, 503)
        self.assertEqual(self.requests, [])
        with self.assertRaises(ModuleLifecycleDenied):
            asyncio.run(self.svc.place_order(self.token, ORDER))

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
