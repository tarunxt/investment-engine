from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.concurrency import run_in_threadpool
from pydantic import AnyHttpUrl, BaseModel, EmailStr, Field

from app.core.config import settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.mails.service import (
    TEST_MESSAGE,
    TEST_RECIPIENTS,
    list_mail_history_sync,
    list_mail_preferences_sync,
    send_manual_test_mail_sync,
    update_mail_preferences_sync,
    update_mail_sell_action_sync,
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
    sell_action: dict[str, object] | None = None


class MailHistoryResponse(BaseModel):
    items: list[MailHistoryItem]


SellActionStatus = Literal[
    "detected",
    "awaiting_confirmation",
    "confirmed",
    "submitting",
    "filled",
    "pending",
    "failed",
    "cleared",
]


class UpdateMailSellActionRequest(BaseModel):
    status: SellActionStatus
    note: str | None = Field(default=None, max_length=2000)
    market_id: str | None = Field(default=None, max_length=128)
    shares: float | None = Field(default=None, ge=0)
    expected_proceeds: float | None = Field(default=None, ge=0)
    proceeds: float | None = Field(default=None, ge=0)
    transaction_url: AnyHttpUrl | None = None
    error: str | None = Field(default=None, max_length=4000)
    market_question: str | None = Field(default=None, max_length=500)
    position_side: Literal["YES", "NO"] | None = None
    live_held_side_bullpen_odds: float | None = Field(default=None, ge=0, le=100)
    sell_threshold: float | None = Field(default=80.0, ge=0, le=100)
    average_sell_price: float | None = Field(default=None, ge=0, le=100)
    evaluated_at: str | None = Field(default=None, max_length=64)
    batch_id: str | None = Field(default=None, max_length=128)


class MailSellActionResponse(BaseModel):
    history_id: int
    sell_action: dict[str, object]


class MailPreferenceItem(BaseModel):
    key: str
    label: str
    description: str
    category: str
    segments: list[str]
    enabled: bool


class MailPreferencesResponse(BaseModel):
    items: list[MailPreferenceItem]


class UpdateMailPreferencesRequest(BaseModel):
    preferences: dict[str, bool]


def _safe_smtp_config() -> dict[str, object]:
    return {
        "host": settings.smtp_host or "(not set)",
        "port": settings.smtp_port,
        "username_configured": bool(settings.smtp_user),
        "password_configured": bool(settings.smtp_password),
        "from_email": settings.smtp_from_email,
        "from_name": settings.smtp_from_name,
    }


@router.get("/preferences", response_model=MailPreferencesResponse)
async def get_mail_preferences(
    current_user: User = Depends(get_current_user),
) -> MailPreferencesResponse:
    items = await run_in_threadpool(
        list_mail_preferences_sync,
        int(current_user.id),
    )
    return MailPreferencesResponse(
        items=[MailPreferenceItem.model_validate(item) for item in items]
    )


@router.put("/preferences", response_model=MailPreferencesResponse)
async def update_mail_preferences(
    request: UpdateMailPreferencesRequest,
    current_user: User = Depends(get_current_user),
) -> MailPreferencesResponse:
    items = await run_in_threadpool(
        update_mail_preferences_sync,
        int(current_user.id),
        request.preferences,
    )
    return MailPreferencesResponse(
        items=[MailPreferenceItem.model_validate(item) for item in items]
    )


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


@router.patch(
    "/history/{history_id}/sell-action",
    response_model=MailSellActionResponse,
)
async def update_mail_sell_action(
    history_id: int,
    request: UpdateMailSellActionRequest,
    current_user: User = Depends(get_current_user),
) -> MailSellActionResponse:
    try:
        sell_action = await run_in_threadpool(
            update_mail_sell_action_sync,
            int(current_user.id),
            history_id,
            action_status=request.status,
            note=request.note,
            market_id=request.market_id,
            shares=request.shares,
            expected_proceeds=request.expected_proceeds,
            proceeds=request.proceeds,
            transaction_url=(
                str(request.transaction_url) if request.transaction_url else None
            ),
            error=request.error,
            market_question=request.market_question,
            position_side=request.position_side,
            live_held_side_bullpen_odds=request.live_held_side_bullpen_odds,
            sell_threshold=request.sell_threshold,
            average_sell_price=request.average_sell_price,
            evaluated_at=request.evaluated_at,
            batch_id=request.batch_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return MailSellActionResponse(history_id=history_id, sell_action=sell_action)


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
