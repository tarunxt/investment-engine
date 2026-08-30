from __future__ import annotations

WORKFLOW_PROFILE = "bullpen008"
WORKFLOW_LABEL = "Bullpen 008"
SHADOW_MODE = True

STAGE_VERSIONS = {
    1: "bullpen008-stage1-v6",
    2: "bullpen008-stage2-v2",
    3: "bullpen008-stage3-v3",
    4: "bullpen008-stage4-v2",
    5: "pending-phase2",
    6: "pending-phase2",
}

LLM_PROMPT_VERSION = "bullpen008-probability-risk-v2"
CLUSTER_PROMPT_VERSION = "bullpen008-cluster-map-v3"
OPTIMIZER_VERSION = "bullpen008-optimizer-v2"
CLUSTER_MAP_VERSION = "bullpen008-cluster-map-v3"

REDIS_PREFIX = "bullpen008"
RUN_LOCK_TTL_SECONDS = 60 * 60
PENDING_MARKER_TTL_SECONDS = 60 * 60
COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS = 10 * 60

CELERY_TASK_NAME = "app.domains.bullpen008.tasks.execute_bullpen008_shadow_run"
CELERY_SCHEDULER_TASK_NAME = "app.domains.bullpen008.tasks.enqueue_due_bullpen008_runs"
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
        "submitted",
        "pending",
        "confirming",
        "partially_filled",
        "retrying",
        "blocked",
    }
)
