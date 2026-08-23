from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, EmailStr

from app.core.config import settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.mails.service import (
    TEST_MESSAGE,
    TEST_RECIPIENTS,
    list_mail_history_sync,
    send_manual_test_mail_sync,
)

router = APIRouter(prefix="/mails", tags=["mails"])


class SendTestMailResponse(BaseModel):
    sent: bool
    recipients: list[EmailStr]
    message: str
    history_id: int


class MailHistoryItem(BaseModel):
    id: int
    created_at: str
    status: str
    category: str
    trigger: str
    recipients: list[str]
    subject: str
    message: str
    remarks: str
    run_id: str | None = None
    threshold: float | None = None
    warnings: list[dict[str, object]]
    attempted_at: str | None = None
    sent_at: str | None = None
    provider_code: str | None = None
    provider_summary: str | None = None
    provider_message: str | None = None
    how_to_fix: list[str]


class MailHistoryResponse(BaseModel):
    items: list[MailHistoryItem]


def _safe_smtp_config() -> dict[str, object]:
    return {
        "host": settings.smtp_host or "(not set)",
        "port": settings.smtp_port,
        "username_configured": bool(settings.smtp_user),
        "password_configured": bool(settings.smtp_password),
        "from_email": settings.smtp_from_email,
        "from_name": settings.smtp_from_name,
    }


@router.get("/history", response_model=MailHistoryResponse)
async def get_mail_history(
    limit: int = Query(default=100, ge=1, le=200),
    current_user: User = Depends(get_current_user),
) -> MailHistoryResponse:
    items = await run_in_threadpool(
        list_mail_history_sync,
        int(current_user.id),
        limit=limit,
    )
    return MailHistoryResponse(
        items=[MailHistoryItem.model_validate(item) for item in items]
    )


@router.post("/send-test", response_model=SendTestMailResponse)
async def send_test_mail(
    current_user: User = Depends(get_current_user),
) -> SendTestMailResponse:
    """Send the fixed Cred-X message and retain the attempt in mail history."""
    delivery = await run_in_threadpool(
        send_manual_test_mail_sync,
        int(current_user.id),
    )
    result = delivery.result
    if not result.sent:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE
            if result.code in {
                "SMTP_NOT_CONFIGURED",
                "SMTP_CREDENTIALS_INCOMPLETE",
                "SMTP_SENDER_PLACEHOLDER",
                "SMTP_PASSWORD_PLACEHOLDER",
                "SMTP_CONNECTION_FAILED",
            }
            else status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": result.code,
                "summary": result.summary,
                "provider_message": result.provider_message,
                "how_to_fix": list(result.how_to_fix),
                "configuration": _safe_smtp_config(),
                "history_id": delivery.history_id,
            },
        )

    return SendTestMailResponse(
        sent=True,
        recipients=list(TEST_RECIPIENTS),
        message=TEST_MESSAGE,
        history_id=delivery.history_id,
    )
