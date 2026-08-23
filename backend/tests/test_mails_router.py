from __future__ import annotations

from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from app.domains.mails import router as mails_router
from app.domains.mails.service import LoggedMailDelivery
from app.services.email import EmailSendResult


@pytest.mark.anyio
async def test_send_test_mail_returns_logged_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[int] = []
    result = EmailSendResult(
        sent=True,
        code="EMAIL_SENT",
        summary="Accepted",
    )
    monkeypatch.setattr(
        mails_router,
        "send_manual_test_mail_sync",
        lambda user_id: (
            observed.append(user_id)
            or LoggedMailDelivery(
                history_id=42,
                result=result,
                details={"status": "sent", "category": "alerts"},
            )
        ),
    )

    response = await mails_router.send_test_mail(
        current_user=SimpleNamespace(id=7),
    )

    assert observed == [7]
    assert response.sent is True
    assert response.history_id == 42
    assert response.recipients == ["tarun.singh6893@gmail.com"]
    assert response.message == "Hi, this a message from Tarun's Cred-X"


@pytest.mark.anyio
async def test_send_test_mail_returns_actionable_safe_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(mails_router.settings, "smtp_host", "smtp.gmail.com")
    monkeypatch.setattr(mails_router.settings, "smtp_port", 587)
    monkeypatch.setattr(mails_router.settings, "smtp_user", "sender@gmail.com")
    monkeypatch.setattr(mails_router.settings, "smtp_password", "secret-value")
    monkeypatch.setattr(mails_router.settings, "smtp_from_email", "sender@gmail.com")
    monkeypatch.setattr(mails_router.settings, "smtp_from_name", "Cred-X")
    result = EmailSendResult(
        sent=False,
        code="SMTP_AUTHENTICATION_FAILED",
        summary="The SMTP server rejected the username or password.",
        provider_message="535 5.7.8 Username and Password not accepted",
        how_to_fix=("Use a Gmail App Password.",),
    )
    monkeypatch.setattr(
        mails_router,
        "send_manual_test_mail_sync",
        lambda _user_id: LoggedMailDelivery(
            history_id=43,
            result=result,
            details={"status": "failed", "category": "alerts"},
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await mails_router.send_test_mail(
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 502
    detail = exc_info.value.detail
    assert detail["code"] == "SMTP_AUTHENTICATION_FAILED"
    assert detail["provider_message"] == "535 5.7.8 Username and Password not accepted"
    assert detail["how_to_fix"] == ["Use a Gmail App Password."]
    assert detail["history_id"] == 43
    assert detail["configuration"] == {
        "host": "smtp.gmail.com",
        "port": 587,
        "username_configured": True,
        "password_configured": True,
        "from_email": "sender@gmail.com",
        "from_name": "Cred-X",
    }
    assert "secret-value" not in str(detail)
