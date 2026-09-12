from __future__ import annotations

import json
import logging
from html import escape

import redis
from sqlalchemy import select

from app.core.config import settings
from app.domains.auth.models import ActivityLog, User
from app.domains.mails.completion_events import PENDING_ACTION, RESOURCE
from app.domains.mails.service import MAIL_CATEGORY_RUNS, send_logged_email_sync
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = logging.getLogger(__name__)


def build_completion_email(data):
    segment = {"zerodha": "Zerodha", "indmoney": "IndMoney", "bullpen": "Bullpen"}[data["segment"]]
    label = data["label"].replace(" · ", " - ")
    # Stable, exact subject reserved for the GPT Work clustering trigger.
    subject = ("Cred-X: Bullpen Stage 1 completed" if data["segment"] == "bullpen" and data["stage"] == "scan"
               else f"Cred-X: {segment} {label} completed")
    history = settings.frontend_url.rstrip('/') + (
        "/console/bullpen-ai/history" if data["segment"] == "bullpen" else "/console/runs"
    )
    lines = [subject, f"Run ID: {data['run_id']}", f"Completed at: {data['completed_at']}"]
    if data.get("filtered_count") is not None:
        lines.append(f"Events that passed Filters: {data['filtered_count']}")
    lines.extend([str(data.get("summary") or ""), f"History: {history}"])
    text = "\n".join(lines)
    html = "<html><body>" + "".join(f"<p>{escape(line)}</p>" for line in lines[:-1])
    return subject, html + f'<p><a href="{escape(history)}">Open History</a></p></body></html>', text


def completion_recipients(data, user_email):
    """Route only Bullpen Stage 1 handoffs to the cross-account webhook inbox."""
    if data.get("segment") == "bullpen" and data.get("stage") == "scan":
        recipient = str(settings.bullpen_stage1_completion_recipient or "").strip()
        if recipient:
            return (recipient,)
    return (str(user_email),)


@celery.task(bind=True, max_retries=3, default_retry_delay=60, queue="email",
             soft_time_limit=90, time_limit=120)
def deliver_completion_email(self, event_id):
    # Prevent parallel beat recovery/redelivery from racing the SMTP reservation.
    client = redis.from_url(settings.redis_url)
    lock = client.lock(f"completion-email:{event_id}", timeout=180, blocking_timeout=0)
    acquired = False
    try:
        acquired = lock.acquire(blocking=False)
        if not acquired:
            raise self.retry(countdown=30)
        with SyncSessionLocal() as session:
            row = session.get(ActivityLog, event_id)
            if not row or row.action != PENDING_ACTION or row.resource_type != RESOURCE:
                return
            data = json.loads(row.details)
            user = session.get(User, row.user_id)
            if not user or not user.email:
                row.action = "completion.failed"
                data["error"] = "Completion email recipient is unavailable"
                row.details = json.dumps(data)
                session.commit()
                logger.error("Completion %s has no recipient", event_id)
                return
            subject, html, text = build_completion_email(data)
            delivery = send_logged_email_sync(
                session, user_id=row.user_id, action="mail.stage_completion",
                trigger=f"{data['segment']} {data['label']}", category=MAIL_CATEGORY_RUNS,
                completion_preference=f"completion.{data['segment']}.{data['stage']}",
                recipients=completion_recipients(data, user.email), subject=subject, html_content=html,
                text_content=text, remarks="Automatic completion notification from committed workflow output.",
                idempotency_key=f"completion:{event_id}", run_id=data["run_id"],
            )
            data["delivery_id"] = delivery.history_id
            data["delivery_status"] = delivery.details.get("status")
            row.action = "completion.processed" if delivery.result.sent else "completion.failed"
            if not delivery.result.sent:
                data["error"] = delivery.result.summary
                logger.error("Completion email %s failed: %s", event_id, delivery.result.summary)
            row.details = json.dumps(data)
            session.commit()
    except Exception as exc:
        logger.exception("Completion email task failed for %s", event_id)
        raise self.retry(exc=exc)
    finally:
        if acquired:
            try:
                lock.release()
            except redis.exceptions.LockError:
                logger.warning("Completion email lock expired for %s", event_id)
        client.close()


@celery.task(queue="beat", soft_time_limit=30, time_limit=45)
def recover_completion_emails():
    with SyncSessionLocal() as session:
        ids = session.scalars(select(ActivityLog.id).where(
            ActivityLog.action == PENDING_ACTION, ActivityLog.resource_type == RESOURCE,
        ).order_by(ActivityLog.id).limit(100)).all()
    for event_id in ids:
        deliver_completion_email.delay(event_id)
