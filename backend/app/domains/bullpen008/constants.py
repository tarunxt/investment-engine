from __future__ import annotations

WORKFLOW_PROFILE = "bullpen008"
WORKFLOW_LABEL = "Bullpen 008"
SHADOW_MODE = True

STAGE_VERSIONS = {
    1: "bullpen008-stage1-v1",
    2: "bullpen008-stage2-v1",
    3: "bullpen008-stage3-v2",
    4: "bullpen008-stage4-v1",
    5: "pending-phase2",
    6: "pending-phase2",
}

LLM_PROMPT_VERSION = "bullpen008-probability-risk-v1"
CLUSTER_PROMPT_VERSION = "bullpen008-cluster-map-v2"
OPTIMIZER_VERSION = "bullpen008-optimizer-v1"
CLUSTER_MAP_VERSION = "bullpen008-cluster-map-v2"

REDIS_PREFIX = "bullpen008"
RUN_LOCK_TTL_SECONDS = 60 * 60
PENDING_MARKER_TTL_SECONDS = 60 * 60

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
