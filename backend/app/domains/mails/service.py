from __future__ import annotations

import html
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domains.auth.models import ActivityLog
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveStageResult,
)
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.services.email import EmailSendResult, EmailService

MAIL_ACTION_PREFIX = "mail."
MAIL_RESOURCE_TYPE = "cred_x_mail"
MAIL_CATEGORY_ALL = "all"
MAIL_CATEGORY_RUNS = "runs"
MAIL_CATEGORY_ALERTS = "alerts"
MAIL_CATEGORY_ACCOUNT = "account"
STAGE2_WARNING_ACTION = "mail.stage2_position_warning"
MANUAL_TEST_ACTION = "mail.manual_test"
STAGE2_WARNING_THRESHOLD = 80.0

TEST_RECIPIENTS = ("tarun.singh6893@gmail.com",)
TEST_SUBJECT = "Message from Tarun's Cred-X"
TEST_MESSAGE = "Hi, this a message from Tarun's Cred-X"


@dataclass(frozen=True)
class Stage2PositionWarning:
    market_id: str
    question: str
    market_url: str | None
    position_side: str
    held_side_llm_odds: float
    opposite_side_llm_odds: float | None
    threshold: float

    def as_dict(self) -> dict[str, object]:
        return {
            "market_id": self.market_id,
            "question": self.question,
            "market_url": self.market_url,
            "position_side": self.position_side,
            "held_side_llm_odds": self.held_side_llm_odds,
            "opposite_side_llm_odds": self.opposite_side_llm_odds,
            "threshold": self.threshold,
            "recommended_action": "EXIT",
        }


@dataclass(frozen=True)
class LoggedMailDelivery:
    history_id: int
    result: EmailSendResult
    details: dict[str, object]
    deduplicated: bool = False


def _utc_iso() -> str:
    return datetime.now(UTC).isoformat()


def _as_probability(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        probability = float(value)
    except (TypeError, ValueError):
        return None
    if probability < 0 or probability > 100:
        return None
    return round(probability, 2)


def _completed_stage_two(
    run: BullpenAutoLiveRun,
) -> BullpenAutoLiveStageResult | None:
    for stage in run.stage_results:
        if (
            stage.stage_number == 2
            or stage.outputs.get("workflow_stage_key") == "llm"
        ) and stage.completed_at:
            return stage
    return None


def extract_stage2_position_warnings(
    run: BullpenAutoLiveRun,
    *,
    threshold: float = STAGE2_WARNING_THRESHOLD,
) -> list[Stage2PositionWarning]:
    """Return active positions whose consolidated held-side odds are below the threshold."""
    stage = _completed_stage_two(run)
    if stage is None:
        return []

    rows = stage.outputs.get("llm_reviewed_candidates")
    if not isinstance(rows, list):
        return []

    warnings: list[Stage2PositionWarning] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("source_kind") != "active_position":
            continue
        side = str(row.get("position_side") or "").strip().upper()
        if side not in {"YES", "NO"}:
            continue
        yes_odds = _as_probability(row.get("fair_yes_probability_pct"))
        no_odds = _as_probability(row.get("fair_no_probability_pct"))
        held_odds = yes_odds if side == "YES" else no_odds
        opposite_odds = no_odds if side == "YES" else yes_odds
        if held_odds is None or held_odds >= threshold:
            continue

        market_id = str(row.get("market_id") or "").strip()
        position_key = str(row.get("position_key") or f"{market_id}::{side}")
        if not market_id or position_key in seen:
            continue
        seen.add(position_key)
        warnings.append(
            Stage2PositionWarning(
                market_id=market_id,
                question=str(row.get("question") or market_id),
                market_url=(
                    str(row["market_url"]).strip()
                    if row.get("market_url")
                    else None
                ),
                position_side=side,
                held_side_llm_odds=held_odds,
                opposite_side_llm_odds=opposite_odds,
                threshold=threshold,
            )
        )
    return warnings


def build_stage2_warning_email(
    run: BullpenAutoLiveRun,
    warnings: list[Stage2PositionWarning],
) -> tuple[str, str, str, str]:
    count = len(warnings)
    noun = "position" if count == 1 else "positions"
    subject = (
        f"WARNING: Exit required — {count} active {noun} below "
        f"{STAGE2_WARNING_THRESHOLD:g}% LLM odds"
    )
    intro = (
        "Stage 2 has completed and the consolidated LLM odds are crystallised. "
        f"The held-side probability is below {STAGE2_WARNING_THRESHOLD:g}% for "
        f"{count} active {noun}."
    )
    text_parts = [
        "WARNING — ACTIVE POSITION EXIT REQUIRED",
        "",
        intro,
        "",
    ]
    html_rows: list[str] = []
    for index, warning in enumerate(warnings, start=1):
        opposite_side = "NO" if warning.position_side == "YES" else "YES"
        url_line = f"\nMarket: {warning.market_url}" if warning.market_url else ""
        text_parts.extend(
            [
                f"{index}. {warning.question}",
                f"Held side: {warning.position_side}",
                (
                    "Consolidated held-side LLM odds: "
                    f"{warning.held_side_llm_odds:g}%"
                ),
                (
                    f"Consolidated {opposite_side} LLM odds: "
                    f"{warning.opposite_side_llm_odds:g}%"
                    if warning.opposite_side_llm_odds is not None
                    else f"Consolidated {opposite_side} LLM odds: unavailable"
                ),
                "Action: EXIT this position as soon as practical." + url_line,
                "",
            ]
        )
        safe_url = html.escape(warning.market_url or "")
        market_link = (
            f'<p><a href="{safe_url}">Open market</a></p>' if safe_url else ""
        )
        html_rows.append(
            "<li style=\"margin-bottom:16px\">"
            f"<strong>{html.escape(warning.question)}</strong>"
            f"<p>Held side: {warning.position_side}</p>"
            f"<p>Consolidated held-side LLM odds: "
            f"<strong>{warning.held_side_llm_odds:g}%</strong></p>"
            f"<p>Action: <strong>EXIT this position as soon as practical.</strong></p>"
            f"{market_link}</li>"
        )

    footer = (
        f"Bullpen run: {run.id}\n"
        "This warning was generated immediately after Stage 2 and before Stage 3. "
        "It is an alert only and does not itself submit an exit order."
    )
    text_parts.extend([footer])
    html_content = (
        "<h2 style=\"color:#b91c1c\">WARNING — Active position exit required</h2>"
        f"<p>{html.escape(intro)}</p>"
        f"<ol>{''.join(html_rows)}</ol>"
        f"<p><strong>Bullpen run:</strong> {html.escape(run.id)}</p>"
        "<p>This warning was generated immediately after Stage 2 and before "
        "Stage 3. It is an alert only and does not itself submit an exit order.</p>"
    )
    remarks = (
        "Automatic Stage 2 risk warning. Consolidated held-side LLM odds fell "
        f"below {STAGE2_WARNING_THRESHOLD:g}%; immediate exit review is required. "
        "The notification was evaluated before Stage 3."
    )
    return subject, html_content, "\n".join(text_parts), remarks


def _details_from_row(row: ActivityLog) -> dict[str, Any]:
    try:
        payload = json.loads(row.details or "{}")
    except (TypeError, json.JSONDecodeError):
        payload = {}
    return payload if isinstance(payload, dict) else {}


def _result_from_details(details: dict[str, Any]) -> EmailSendResult:
    return EmailSendResult(
        sent=details.get("status") == "sent",
        code=str(details.get("provider_code") or "EMAIL_DELIVERY_ALREADY_RESERVED"),
        summary=str(
            details.get("provider_summary")
            or "This mail delivery was already reserved by an earlier attempt."
        ),
        provider_message=(
            str(details["provider_message"])
            if details.get("provider_message")
            else None
        ),
        how_to_fix=tuple(
            str(item)
            for item in details.get("how_to_fix", [])
            if isinstance(item, str)
        ),
    )


def send_logged_email_sync(
    session: Session,
    *,
    user_id: int,
    action: str,
    trigger: str,
    recipients: tuple[str, ...],
    subject: str,
    html_content: str,
    text_content: str,
    remarks: str,
    idempotency_key: str,
    run_id: str | None = None,
    threshold: float | None = None,
    warnings: list[dict[str, object]] | None = None,
    category: str = MAIL_CATEGORY_ALERTS,
    audit_message: str | None = None,
) -> LoggedMailDelivery:
    """Reserve, send, and finalize a user-visible delivery record.

    The reservation is committed before SMTP. A redelivered Stage 2 task therefore
    observes the existing idempotency key and never sends a duplicate message.
    """
    marker = f'"idempotency_key": "{idempotency_key}"'
    existing = session.execute(
        select(ActivityLog)
        .where(ActivityLog.user_id == user_id)
        .where(ActivityLog.action == action)
        .where(ActivityLog.resource_type == MAIL_RESOURCE_TYPE)
        .where(ActivityLog.details.contains(marker))
        .order_by(ActivityLog.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        existing_details = _details_from_row(existing)
        return LoggedMailDelivery(
            history_id=int(existing.id),
            result=_result_from_details(existing_details),
            details=existing_details,
            deduplicated=True,
        )

    attempted_at = _utc_iso()
    details: dict[str, object] = {
        "schema_version": 1,
        "idempotency_key": idempotency_key,
        "status": "sending",
        "category": category,
        "trigger": trigger,
        "recipients": list(recipients),
        "subject": subject,
        "message": audit_message if audit_message is not None else text_content,
        "remarks": remarks,
        "run_id": run_id,
        "threshold": threshold,
        "warnings": warnings or [],
        "attempted_at": attempted_at,
        "sent_at": None,
        "provider_code": None,
        "provider_summary": "Delivery reserved; awaiting SMTP result.",
        "provider_message": None,
        "how_to_fix": [],
    }
    row = ActivityLog(
        user_id=user_id,
        action=action,
        resource_type=MAIL_RESOURCE_TYPE,
        resource_id=None,
        details=json.dumps(details, ensure_ascii=False),
    )
    session.add(row)
    session.commit()
    session.refresh(row)

    results = [
        EmailService.send_email_detailed(
            recipient,
            subject,
            html_content,
            text_content,
        )
        for recipient in recipients
    ]
    first_failure = next((result for result in results if not result.sent), None)
    result = first_failure or EmailSendResult(
        sent=True,
        code="EMAIL_SENT",
        summary="Email accepted by the SMTP provider.",
    )
    details.update(
        {
            "status": "sent" if result.sent else "failed",
            "sent_at": _utc_iso() if result.sent else None,
            "provider_code": result.code,
            "provider_summary": result.summary,
            "provider_message": result.provider_message,
            "how_to_fix": list(result.how_to_fix),
        }
    )
    row.details = json.dumps(details, ensure_ascii=False)
    session.add(row)
    session.commit()
    return LoggedMailDelivery(
        history_id=int(row.id),
        result=result,
        details=details,
    )


def send_manual_test_mail_sync(user_id: int) -> LoggedMailDelivery:
    with SyncSessionLocal() as session:
        return send_logged_email_sync(
            session,
            user_id=user_id,
            action=MANUAL_TEST_ACTION,
            trigger="Manual test",
            recipients=TEST_RECIPIENTS,
            subject=TEST_SUBJECT,
            html_content=f"<p>{html.escape(TEST_MESSAGE)}</p>",
            text_content=TEST_MESSAGE,
            remarks="Manual test email sent from the Cred-X Mails screen.",
            idempotency_key=f"manual-test:{uuid4()}",
        )


def notify_stage2_position_warnings_sync(
    session: Session,
    *,
    user_id: int,
    run: BullpenAutoLiveRun,
) -> dict[str, object]:
    stage = _completed_stage_two(run)
    if stage is None:
        return {"status": "stage2_not_complete"}

    existing_metadata = run.audit_metadata.get("stage2_position_warning_mail")
    if isinstance(existing_metadata, dict):
        return existing_metadata

    warnings = extract_stage2_position_warnings(run)
    processed_at = _utc_iso()
    if not warnings:
        metadata: dict[str, object] = {
            "status": "not_required",
            "threshold": STAGE2_WARNING_THRESHOLD,
            "breach_count": 0,
            "stage2_completed_at": stage.completed_at,
            "processed_at": processed_at,
        }
    else:
        subject, html_content, text_content, remarks = build_stage2_warning_email(
            run,
            warnings,
        )
        delivery = send_logged_email_sync(
            session,
            user_id=user_id,
            action=STAGE2_WARNING_ACTION,
            trigger="Stage 2 active-position LLM odds",
            recipients=TEST_RECIPIENTS,
            subject=subject,
            html_content=html_content,
            text_content=text_content,
            remarks=remarks,
            idempotency_key=(
                f"stage2-position-warning:{run.id}:"
                f"{STAGE2_WARNING_THRESHOLD:g}:v1"
            ),
            run_id=run.id,
            threshold=STAGE2_WARNING_THRESHOLD,
            warnings=[warning.as_dict() for warning in warnings],
        )
        metadata = {
            "status": str(delivery.details.get("status") or "unknown"),
            "history_id": delivery.history_id,
            "threshold": STAGE2_WARNING_THRESHOLD,
            "breach_count": len(warnings),
            "stage2_completed_at": stage.completed_at,
            "processed_at": processed_at,
            "deduplicated": delivery.deduplicated,
            "provider_code": delivery.result.code,
        }

    run.audit_metadata = dict(run.audit_metadata)
    run.audit_metadata["stage2_position_warning_mail"] = metadata
    return metadata


def _mail_category(action: str, details: dict[str, Any]) -> str:
    explicit = str(details.get("category") or "").strip().lower()
    if explicit in {MAIL_CATEGORY_RUNS, MAIL_CATEGORY_ALERTS, MAIL_CATEGORY_ACCOUNT}:
        return explicit
    if action in {"mail.run_completion", "mail.auto_rebalance_success"}:
        return MAIL_CATEGORY_RUNS
    if action == "mail.password_reset":
        return MAIL_CATEGORY_ACCOUNT
    return MAIL_CATEGORY_ALERTS


def list_mail_history_sync(user_id: int, *, limit: int = 100) -> list[dict[str, object]]:
    bounded_limit = max(1, min(limit, 200))
    with SyncSessionLocal() as session:
        rows = (
            session.execute(
                select(ActivityLog)
                .where(ActivityLog.user_id == user_id)
                .where(ActivityLog.resource_type == MAIL_RESOURCE_TYPE)
                .where(ActivityLog.action.like(f"{MAIL_ACTION_PREFIX}%"))
                .order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
                .limit(bounded_limit)
            )
            .scalars()
            .all()
        )
        items: list[dict[str, object]] = []
        for row in rows:
            details = _details_from_row(row)
            items.append(
                {
                    "id": int(row.id),
                    "created_at": row.created_at.isoformat(),
                    "status": str(details.get("status") or "unknown"),
                    "category": _mail_category(row.action, details),
                    "trigger": str(details.get("trigger") or row.action),
                    "recipients": details.get("recipients") or [],
                    "subject": str(details.get("subject") or ""),
                    "message": str(details.get("message") or ""),
                    "remarks": str(details.get("remarks") or ""),
                    "run_id": details.get("run_id"),
                    "threshold": details.get("threshold"),
                    "warnings": details.get("warnings") or [],
                    "attempted_at": details.get("attempted_at"),
                    "sent_at": details.get("sent_at"),
                    "provider_code": details.get("provider_code"),
                    "provider_summary": details.get("provider_summary"),
                    "provider_message": details.get("provider_message"),
                    "how_to_fix": details.get("how_to_fix") or [],
                }
            )
        return items
