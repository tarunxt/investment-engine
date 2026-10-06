"""Explicit, fail-closed application containment for an analysis-only recovery.

This is application policy, not a credential or operating-system permission change.
Only CREDX_RECOVERY_MODE=1 enables it; malformed values refuse startup/execution.
"""
import os

from app.shared.exceptions import AppException

ANALYSIS_TASK = "app.domains.jobs.tasks.execute_ai_job"
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


def require_indmoney_analysis(portfolio, context=None, *, auto_export=False):
    if not recovery_mode():
        return
    if portfolio != "indmoney_us" or auto_export:
        raise RecoveryBlocked("Non-INDmoney or externally exported job")
    if context is not None and (
        not isinstance(context, dict)
        or context.get("kind") != "equity_output_sources_v1"
        or context.get("market") != "us"
    ):
        raise RecoveryBlocked("Non-equity analysis context")


def require_task_allowed(name):
    if recovery_mode() and name != ANALYSIS_TASK:
        raise RecoveryBlocked("Task outside the analysis allowlist")


def recovery_http_allowed(method, path):
    """Minimal API surface for login, existing data, and INDmoney fanout/results."""
    if method == "OPTIONS":
        return True
    if method in {"GET", "HEAD"}:
        return any(path == p or path.startswith(p + "/") for p in (
            "/health", "/auth/me", "/auth/profile", "/indmoney-us", "/runs",
            "/jobs", "/prompts", "/providers", "/api-usage",
        ))
    if method == "POST":
        return path in {
            "/auth/login", "/auth/refresh", "/auth/logout", "/auth/websocket-ticket",
            "/indmoney-us/portfolio", "/indmoney-us/prices/current",
            "/indmoney-us/events/run", "/indmoney-us/threats/run", "/runs", "/jobs",
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
