"""Completion outbox stored with the existing ActivityLog model.

Domain writers hold the run/workflow row lock and add events in the same
transaction. Celery is notified only after commit; beat recovers broker failures.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.domains.auth.models import ActivityLog
from app.domains.mails.completion_preferences import BULLPEN_STAGES

logger = logging.getLogger(__name__)
PENDING_ACTION = "completion.pending"
RESOURCE = "completion_notification"
SESSION_KEY = "completion_notification_rows"


def add_completion_event(session, *, user_id, payload):
    row = ActivityLog(
        user_id=user_id, action=PENDING_ACTION, resource_type=RESOURCE,
        resource_id=None, details=json.dumps(payload, ensure_ascii=False),
    )
    session.add(row)
    session.info.setdefault(SESSION_KEY, []).append(row)


@event.listens_for(Session, "after_commit")
def dispatch_committed_completions(session):
    rows = session.info.pop(SESSION_KEY, [])
    if not rows:
        return
    from app.domains.mails.tasks import deliver_completion_email
    for row in rows:
        try:
            deliver_completion_email.delay(row.id)
        except Exception:
            logger.exception("Completion email %s awaits outbox recovery", row.id)


@event.listens_for(Session, "after_rollback")
def discard_rolled_back_completions(session):
    session.info.pop(SESSION_KEY, None)


def bullpen_completion_payloads(payload):
    """Only the three-stage console workflow emits these notifications."""
    stages = payload.get("stage_results") or []
    result = {}
    for stage in stages:
        outputs = stage.get("outputs") or {}
        number = stage.get("stage_number")
        if number not in (1, 2, 3) or outputs.get("phase_status") != "completed":
            continue
        if not stage.get("completed_at"):
            continue
        key, label = BULLPEN_STAGES[number - 1]
        # The seven-stage guardrail workflow is a separate product; never mistake
        # its stage numbers for the console's scan/LLM/execution stages.
        if outputs.get("workflow_stage_key") != key:
            continue
        if key == "scan" and (
            outputs.get("scan_completeness") not in {"complete", "trending"}
            or not isinstance(outputs.get("accepted_candidates_count"), int)
        ):
            continue
        result[key] = {
            "schema_version": 1, "segment": "bullpen", "stage": key,
            "label": label, "run_id": str(payload["id"]),
            "completed_at": stage["completed_at"],
            "filtered_count": outputs.get("accepted_candidates_count") if key == "scan" else None,
            "summary": stage.get("reason", ""),
        }
    if result and payload.get("status") in {"completed", "partial_success"} and payload.get("completed_at"):
        result["overall"] = {
            "schema_version": 1, "segment": "bullpen", "stage": "overall",
            "label": "Overall completion", "run_id": str(payload["id"]),
            "completed_at": payload["completed_at"], "summary": payload.get("summary", ""),
        }
    return result


def record_bullpen_completions(session, *, user_id, previous, current):
    before = bullpen_completion_payloads(previous) if previous else {}
    for key, payload in bullpen_completion_payloads(current).items():
        if key not in before:
            add_completion_event(session, user_id=user_id, payload=payload)
