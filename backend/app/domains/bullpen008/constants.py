from __future__ import annotations

import re

WORKFLOW_PROFILE = "bullpen008"
WORKFLOW_LABEL = "Bullpen 008"
SHADOW_MODE = True

STAGE_VERSIONS = {
    1: "bullpen008-stage1-v10-p0",
    2: "bullpen008-stage2-v3-p0",
    3: "bullpen008-stage3-v4-p0",
    4: "bullpen008-stage4-v4-p0",
    5: "bullpen008-stage5-v2-p0",
    6: "bullpen008-stage6-v2-p0",
}

LLM_PROMPT_VERSION = "bullpen008-probability-risk-v2"
CLUSTER_PROMPT_VERSION = "bullpen008-cluster-map-v3"
OPTIMIZER_VERSION = "bullpen008-optimizer-v3"
CLUSTER_MAP_VERSION = "bullpen008-cluster-map-v3"
ACTION_PLAN_VERSION = "bullpen008-action-plan-v2-p0"
EXECUTION_VERSION = "bullpen008-execution-v2-p0"
PLAN_MAX_AGE_SECONDS = 15 * 60
WALLET_MAX_AGE_SECONDS = 5 * 60
EXECUTION_ACCOUNT_LOCK_RESOURCE = "bullpen-shared-wallet"

REDIS_PREFIX = "bullpen008"
RUN_LOCK_TTL_SECONDS = 60 * 60
PENDING_MARKER_TTL_SECONDS = 60 * 60
COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS = 10 * 60

CELERY_TASK_NAME = "app.domains.bullpen008.tasks.execute_bullpen008_run"
CELERY_SCHEDULER_TASK_NAME = "app.domains.bullpen008.tasks.enqueue_due_bullpen008_runs"
CELERY_RECOVERY_TASK_NAME = "app.domains.bullpen008.tasks.recover_bullpen008_executions"
CELERY_ALERT_TASK_NAME = "app.domains.bullpen008.tasks.refresh_bullpen008_position_alerts"
CELERY_QUEUE = "auto_live"

SPEECH_WORDING_TERMS = (
    "praise",
    "praises",
    "mention",
    "mentions",
    "insult",
    "nickname",
    "tweet",
    "post",
    "say",
    "says",
)

PENDING_ORDER_STATUSES = frozenset(
    {
        "planned",
        "queued",
        "risk_certified",
        "ready",
        "retry_wait",
        "waiting_for_collateral",
        "waiting_for_exit",
        "submitting",
        "submitted",
        "pending",
        "confirming",
        "partially_filled",
        "settlement_pending",
        "retrying",
        "recoverable",
    }
)


def normalize_order_status(value: object) -> str:
    """Return one canonical status for legacy screaming-snake and 008 CamelCase states."""

    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", text)
    return re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()


def is_active_pending_order_status(value: object) -> bool:
    return normalize_order_status(value) in PENDING_ORDER_STATUSES
