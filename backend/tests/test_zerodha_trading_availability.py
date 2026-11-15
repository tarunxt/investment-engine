"""Capability discovery must agree with recovery enforcement; no broker calls."""
import os
import unittest
from unittest.mock import patch
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/testdb")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.core.recovery import RecoveryBlocked, recovery_http_allowed
from app.core.config import settings
from app.domains.zerodha import service
from app.domains.zerodha.schemas import ZerodhaStatusResponse, ZerodhaLoginUrlResponse


class TradingAvailabilityTest(unittest.TestCase):
    def setUp(self):
        self.settings = patch.object(service, "settings", SimpleNamespace(
            zerodha_api_key="test", zerodha_api_secret="test",
            zerodha_enable_direct_market_orders=True,
        ))
        self.settings.start()
        self.addCleanup(self.settings.stop)
        self.svc = service.ZerodhaService()
        self.policy = patch.object(settings, "zerodha_recovery_manual_orders_enabled", False)
        self.policy.start()
        self.addCleanup(self.policy.stop)

    def test_recovery_blocks_advertised_capability_and_keeps_discovery_readable(self):
        with patch.dict(os.environ, {"CREDX_RECOVERY_MODE": "1"}):
            self.assertFalse(self.svc.direct_market_orders_enabled)
            self.assertIn("analysis-only recovery", self.svc.order_submission_blocked_reason)
            for path in ("/zerodha/status", "/zerodha/login-url"):
                self.assertTrue(recovery_http_allowed("GET", path))
            self.assertFalse(recovery_http_allowed("POST", "/zerodha/orders/place-protected-market-sequenced"))
            for schema, fields in ((ZerodhaStatusResponse, {"connected": True}),
                                   (ZerodhaLoginUrlResponse, {"configured": True, "login_url": ""})):
                response = schema(**fields, direct_market_orders_enabled=self.svc.direct_market_orders_enabled,
                                  order_submission_blocked_reason=self.svc.order_submission_blocked_reason)
                self.assertFalse(response.model_dump()["direct_market_orders_enabled"])
                self.assertIn("recovery", response.model_dump()["order_submission_blocked_reason"])

    def test_normal_mode_preserves_explicit_trading_configuration(self):
        with patch.dict(os.environ, {"CREDX_RECOVERY_MODE": "0"}):
            self.assertTrue(self.svc.direct_market_orders_enabled)
            self.assertIsNone(self.svc.order_submission_blocked_reason)
            service.settings.zerodha_enable_direct_market_orders = False
            self.assertFalse(self.svc.direct_market_orders_enabled)

    def test_invalid_recovery_value_fails_closed(self):
        with patch.dict(os.environ, {"CREDX_RECOVERY_MODE": "invalid"}):
            with self.assertRaises(RecoveryBlocked):
                _ = self.svc.direct_market_orders_enabled


if __name__ == "__main__":
    unittest.main()
