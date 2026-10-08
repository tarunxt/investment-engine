"""Explicit, fail-closed application containment for an analysis-only recovery.

This is application policy, not a credential or operating-system permission change.
Only CREDX_RECOVERY_MODE=1 enables it; malformed values refuse startup/execution.
"""
import os
import re
from decimal import Decimal, InvalidOperation

from app.shared.exceptions import AppException

ANALYSIS_TASK = "app.domains.jobs.tasks.execute_ai_job"
ZERODHA_SYNC_TASK = "app.domains.zerodha.tasks.sync_portfolio_snapshot_task"
RECOVERY_TASKS = frozenset({ANALYSIS_TASK, ZERODHA_SYNC_TASK})
AUDIT_TASK = "app.domains.recommendation_audit.tasks.verify_reversal"

ANALYSIS_QUEUE = "credx_recovery_analysis"
TRANSPORT_PREFIX = "credx:recovery:analysis:v1:"


class RecoveryBlocked(AppException):
    def __init__(self, operation="operation"):
        super().__init__(
            message=f"{operation} is unavailable during analysis-only recovery.",
            code="RECOVERY_CONTAINMENT", status_code=503,
        )


def recovery_mode():
    value = os.getenv("CREDX_RECOVERY_MODE", "0")
    if value not in {"0", "1"}:
        raise RecoveryBlocked("Invalid CREDX_RECOVERY_MODE (expected 0 or 1)")
    return value == "1"


def require_financial_writes_allowed():
    if recovery_mode():
        raise RecoveryBlocked("Financial submission")


def require_bullpen_command_allowed(args):
    # No authenticated CLI is needed for INDmoney analysis. Block ALL commands,
    # including unknown verbs and implicit auth refresh, before any subprocess.
    if recovery_mode():
        raise RecoveryBlocked("Bullpen runtime command")


def require_equity_analysis(portfolio, context=None, *, auto_export=False):
    if not recovery_mode():
        return
    market = {"indmoney_us": "us", "india": "india"}.get(portfolio)
    if market is None or auto_export:
        raise RecoveryBlocked("Non-equity or externally exported job")
    if context is not None and (
        not isinstance(context, dict)
        or context.get("kind") != "equity_output_sources_v1"
        or context.get("market") != market
    ):
        raise RecoveryBlocked("Non-equity analysis context")


# Keep the old import name compatible with existing recovery callers.
require_indmoney_analysis = require_equity_analysis

def require_task_allowed(name):
    if recovery_mode() and name not in recovery_tasks():
        raise RecoveryBlocked("Task outside the analysis allowlist")


def stored_audit_recovery_enabled(configuration=None):
    """A separate default-off exception; every cost-bearing capability stays off."""
    if configuration is None:
        from app.core.config import settings
        configuration = settings
    try:
        return (
            getattr(configuration, "recommendation_audit_enabled", False) is True
            and getattr(configuration, "recommendation_audit_recovery_stored_only_enabled", False) is True
            and getattr(configuration, "recommendation_audit_external_enabled", None) is False
            and getattr(configuration, "recommendation_audit_fundamentals_enabled", None) is False
            and Decimal(str(configuration.recommendation_audit_daily_cap_usd)) == 0
        )
    except (AttributeError, InvalidOperation, ValueError):
        return False


def audit_recovery_blocked(configuration=None):
    return recovery_mode() and not stored_audit_recovery_enabled(configuration)


def recovery_tasks():
    return RECOVERY_TASKS | {AUDIT_TASK} if stored_audit_recovery_enabled() else RECOVERY_TASKS


def require_audit_request_allowed(request, configuration=None, *, record=None):
    """Validate persisted requests too, before dispatch, a lease, or external I/O."""
    if not isinstance(request, dict) or not isinstance(request.get("mode"), str) or request["mode"] not in {"stored_only", "external_data"}:
        raise RecoveryBlocked("Unknown audit verification mode")
    if not recovery_mode():
        return
    if not stored_audit_recovery_enabled(configuration) or request["mode"] != "stored_only":
        raise RecoveryBlocked("Audit verification outside stored-only recovery")
    try:
        values = [request["budget_usd"]]
        if record is not None:
            values.extend((record.budget_usd, record.spent_usd, record.reserved_usd))
        if any(Decimal(str(value)) != 0 for value in values):
            raise ValueError("Nonzero audit budget")
    except (KeyError, AttributeError, InvalidOperation, ValueError):
        raise RecoveryBlocked("Stored-only recovery requires zero audit budget")


def recovery_http_allowed(method, path):
    """Minimal API surface for login, existing data, and INDmoney fanout/results."""
    if method == "OPTIONS":
        return True
    if method in {"GET", "HEAD"} and (
        path in {"/zerodha/status", "/zerodha/login-url", "/zerodha/portfolio"}
        or any(path == prefix or path.startswith(prefix + "/") for prefix in (
            "/zerodha/portfolio", "/zerodha/events", "/zerodha/threats",
        ))
    ):
        return True
    if method == "POST" and path in {"/zerodha/callback", "/zerodha/portfolio/sync"}:
        return True
    if method in {"GET", "HEAD"}:
        return any(path == p or path.startswith(p + "/") for p in (
            "/health", "/auth/me", "/auth/profile", "/indmoney-us", "/runs",
            "/jobs", "/prompts", "/providers", "/api-usage",
        ))
    if method == "POST":
        if stored_audit_recovery_enabled() and (
            path in {"/runs/recommendation-audit/materialize", "/runs/recommendation-audit/calculations", "/runs/recommendation-audit/verifications"}
            or re.fullmatch(r"/runs/recommendation-audit/verifications/[0-9a-fA-F-]{36}/cancel", path)
        ):
            return True
        return path in {
            "/auth/login", "/auth/refresh", "/auth/logout", "/auth/websocket-ticket",
            "/indmoney-us/portfolio", "/indmoney-us/prices/current",
            "/indmoney-us/events/run", "/indmoney-us/threats/run",
            "/zerodha/events/run", "/zerodha/threats/run", "/runs", "/jobs",
            "/runs/auto-rebalance-label", "/runs/final-actionables/history",
        }
    # Workflow audit updates persist stage results only; no queue/bot invocation.
    return method == "PATCH" and path.startswith("/runs/auto-rebalance-history/")


class RecoveryMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and recovery_mode() and not recovery_http_allowed(
            scope["method"], scope["path"],
        ):
            from starlette.responses import JSONResponse
            await JSONResponse(
                {"detail": "Endpoint unavailable during analysis-only recovery.",
                 "code": "RECOVERY_CONTAINMENT"}, status_code=503,
            )(scope, receive, send)
            return
        if scope["type"] == "websocket" and recovery_mode():
            # Polling remains available; avoid side effects in websocket handlers.
            await send({"type": "websocket.close", "code": 1008})
            return
        await self.app(scope, receive, send)
