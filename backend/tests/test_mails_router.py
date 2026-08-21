from __future__ import annotations

from fastapi import HTTPException
import pytest

from app.domains.mails import router as mails_router
from app.services.email import EmailSendResult


@pytest.mark.anyio
async def test_send_test_mail_uses_fixed_recipient_and_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[tuple[str, str, str, str]] = []

    monkeypatch.setattr(
        mails_router.EmailService,
        "send_email_detailed",
        lambda email_to, subject, html_content, text_content: (
            observed.append((email_to, subject, html_content, text_content))
            or EmailSendResult(
                sent=True,
                code="EMAIL_SENT",
                summary="Accepted",
            )
        ),
    )

    response = await mails_router.send_test_mail(current_user=object())

    assert response.sent is True
    assert response.recipients == ["tarun.singh6893@gmail.com"]
    assert response.message == "Hi, this a message from Tarun's Cred-X"
    assert observed == [
        (
            "tarun.singh6893@gmail.com",
            "Message from Tarun's Cred-X",
            "<p>Hi, this a message from Tarun's Cred-X</p>",
            "Hi, this a message from Tarun's Cred-X",
        )
    ]


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
    monkeypatch.setattr(
        mails_router.EmailService,
        "send_email_detailed",
        lambda *_args: EmailSendResult(
            sent=False,
            code="SMTP_AUTHENTICATION_FAILED",
            summary="The SMTP server rejected the username or password.",
            provider_message="535 5.7.8 Username and Password not accepted",
            how_to_fix=("Use a Gmail App Password.",),
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await mails_router.send_test_mail(current_user=object())

    assert exc_info.value.status_code == 502
    detail = exc_info.value.detail
    assert detail["code"] == "SMTP_AUTHENTICATION_FAILED"
    assert detail["provider_message"] == "535 5.7.8 Username and Password not accepted"
    assert detail["how_to_fix"] == ["Use a Gmail App Password."]
    assert detail["configuration"] == {
        "host": "smtp.gmail.com",
        "port": 587,
        "username_configured": True,
        "password_configured": True,
        "from_email": "sender@gmail.com",
        "from_name": "Cred-X",
    }
    assert "secret-value" not in str(detail)
