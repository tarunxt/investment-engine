from __future__ import annotations

from fastapi import HTTPException
import pytest

from app.domains.mails import router as mails_router


@pytest.mark.anyio
async def test_send_test_mail_uses_fixed_recipient_and_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[tuple[str, str, str, str]] = []

    monkeypatch.setattr(mails_router.settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(
        mails_router.EmailService,
        "send_email",
        lambda email_to, subject, html_content, text_content: (
            observed.append((email_to, subject, html_content, text_content)) or True
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
async def test_send_test_mail_fails_when_smtp_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(mails_router.settings, "smtp_host", None)

    with pytest.raises(HTTPException) as exc_info:
        await mails_router.send_test_mail(current_user=object())

    assert exc_info.value.status_code == 503
