"""Synthetic acceptance with stdlib only: no application startup/connections."""
import ast
import asyncio
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "app/domains/health/execution.py"
spec = importlib.util.spec_from_file_location("passive_execution_under_test", PATH)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
Snapshot = module.ExecutionSnapshot


class ExecutionHealthTests(unittest.IsolatedAsyncioTestCase):
    def snapshot(self, **overrides):
        fields = dict(consumer="fresh", pending_count=0,
                      durable_claims_verified=True, dispatch_verified=True,
                      exhausted_retry_count=0)
        fields.update(overrides)
        return Snapshot(**fields)

    def test_states_and_missing_progress(self):
        cases = [
            ({}, "idle_empty"),
            ({"pending_count": 2, "oldest_pending_age_seconds": 10}, "queued_with_worker"),
            ({"consumer": "stale"}, "stale_heartbeat"),
            ({"consumer": "missing"}, "consumer_unavailable"),
            ({"consumer": "partial"}, "partial_inspect"),
            ({"durable_claims_verified": None}, "unavailable_metrics"),
            ({"dispatch_verified": None}, "unavailable_metrics"),
            ({"pending_count": None}, "unavailable_metrics"),
            ({"pending_count": 2}, "unavailable_metrics"),
            ({"exhausted_retry_count": 1}, "exhausted_retry"),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                result = module.summarize(self.snapshot(**fields), recovery=True)
                self.assertEqual(result["state"], expected)
                self.assertFalse(result["deployment_gate"])
                self.assertEqual(result["financial_services"], "intentional_containment")

    async def test_default_unknown_and_containment(self):
        result = await module.execution_diagnostics(recovery=True)
        self.assertEqual(result["state"], "unavailable_metrics")
        self.assertEqual(result["progress"], "unknown")
        self.assertNotEqual(result["status"], "healthy")
        self.assertIsNone(result["pending_count"])
        self.assertIsNone(result["acceptance_threshold"])
        self.assertIsNone(result["escalation_owner"])
        normal = await module.execution_diagnostics(recovery=False)
        self.assertEqual(normal["financial_services"], "not_assessed")

    async def test_timeout_cancels_reader_and_redacts_failure(self):
        cancelled = asyncio.Event()

        async def delayed():
            try:
                await asyncio.sleep(100)
            finally:
                cancelled.set()

        result = await asyncio.wait_for(module.execution_diagnostics(
            recovery=True, reader=delayed, timeout_seconds=0.01), timeout=0.2)
        self.assertTrue(cancelled.is_set())
        self.assertEqual(result["progress"], "unknown")
        self.assertNotEqual(result["status"], "healthy")

        async def failed():
            raise RuntimeError("synthetic-private-address-and-token")

        result = await module.execution_diagnostics(recovery=True, reader=failed)
        self.assertNotIn("synthetic-private", str(result))

    def test_invalid_metrics_remain_unknown_and_redacted(self):
        result = module.summarize(self.snapshot(
            consumer="synthetic-private-worker", pending_count=-1,
            oldest_pending_age_seconds=float("nan")), recovery=True)
        self.assertIsNone(result["pending_count"])
        self.assertIsNone(result["oldest_pending_age_seconds"])
        self.assertEqual(result["consumer"], "unknown")
        self.assertEqual(result["progress"], "unknown")
        self.assertNotEqual(result["status"], "healthy")

    def test_durable_states_are_not_receipt_or_heartbeat(self):
        Row = module.DurableProjection
        result = module.summarize_durable([
            Row("pending", 90), Row("uncertain", 80), Row("delivered", 70, "owned", 110),
            Row("dead_letter", 60, "reconciliation_needed"),
            Row("suppressed", 50, "owned", 99, True),
        ], now=100, complete=True)
        self.assertTrue(result["scope_complete"])
        self.assertEqual(result["oldest_unresolved_age_seconds"], 20)
        self.assertEqual(result["sample_counts"]["expired_claim"], 1)
        self.assertEqual(result["sample_counts"]["reconciliation_needed"], 1)
        for key in ("consumer", "receipt", "service_state"):
            self.assertEqual(result[key], "unknown")
        self.assertIsNone(result["exhausted_retry_count"])

    def test_durable_projection_caps_iteration_and_keeps_unknown(self):
        consumed = []

        def rows():
            for i in range(1000):
                consumed.append(i)
                yield module.DurableProjection("pending", 90)

        result = module.summarize_durable(rows(), now=100, complete=True)
        self.assertEqual(len(consumed), 101)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["scope_complete"])
        self.assertIsNone(result["oldest_unresolved_age_seconds"])
        result = module.summarize_durable([], now=100)
        self.assertFalse(result["scope_complete"])
        for row in (module.DurableProjection("new_state", 90),
                    module.DurableProjection("pending", float("nan")),
                    module.DurableProjection("pending", 101)):
            self.assertFalse(module.summarize_durable(
                [row], now=100, complete=True)["scope_complete"])

    def test_no_mutation_or_external_imports(self):
        tree = ast.parse(PATH.read_text())
        imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        imports.update(alias.name for node in ast.walk(tree) if isinstance(node, ast.Import)
                       for alias in node.names)
        self.assertLessEqual(imports, {"__future__", "asyncio", "dataclasses", "typing", "math", "itertools"})
        forbidden = {"send_task", "apply_async", "delay", "publish", "execute", "commit",
                     "refresh", "inspect", "get_provider", "system", "Popen"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(node.func.attr, forbidden)
        router = ast.parse((ROOT / "app/domains/health/router.py").read_text())
        endpoint = next(node for node in router.body if isinstance(node, ast.AsyncFunctionDef)
                        and node.name == "health_execution")
        calls = [node for node in ast.walk(endpoint) if isinstance(node, ast.Call)]
        self.assertEqual({node.func.id for node in calls if isinstance(node.func, ast.Name)},
                         {"recovery_mode", "execution_diagnostics"})


if __name__ == "__main__":
    unittest.main()
