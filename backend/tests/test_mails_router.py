from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.domains.mails import router as mails_router
from app.domains.mails.service import LoggedMailDelivery
from app.services.email import EmailSendResult
from fastapi import HTTPException


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


@pytest.mark.anyio
async def test_get_mail_preferences_returns_all_types(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    items = [
        {
            "key": "run_completion",
            "label": "Stage and scan completion",
            "description": "Individual run-completion emails.",
            "category": "runs",
            "segments": ["Zerodha", "IndMoney"],
            "enabled": False,
        }
    ]
    monkeypatch.setattr(
        mails_router,
        "list_mail_preferences_sync",
        lambda user_id: items if user_id == 7 else [],
    )

    response = await mails_router.get_mail_preferences(
        current_user=SimpleNamespace(id=7),
    )

    assert len(response.items) == 1
    assert response.items[0].key == "run_completion"
    assert response.items[0].enabled is False


@pytest.mark.anyio
async def test_update_mail_preferences_saves_checkbox_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[tuple[int, dict[str, bool]]] = []

    def save(user_id: int, preferences: dict[str, bool]):
        observed.append((user_id, preferences))
        return [
            {
                "key": "run_completion",
                "label": "Stage and scan completion",
                "description": "Individual run-completion emails.",
                "category": "runs",
                "segments": ["Zerodha", "IndMoney"],
                "enabled": preferences["run_completion"],
            }
        ]

    monkeypatch.setattr(mails_router, "update_mail_preferences_sync", save)
    response = await mails_router.update_mail_preferences(
        request=mails_router.UpdateMailPreferencesRequest(
            preferences={"run_completion": False},
        ),
        current_user=SimpleNamespace(id=7),
    )

    assert observed == [(7, {"run_completion": False})]
    assert response.items[0].enabled is False


@pytest.mark.anyio
async def test_update_mail_sell_action_returns_persisted_lifecycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[tuple[int, int, dict[str, object]]] = []

    def update(user_id: int, history_id: int, **values: object):
        observed.append((user_id, history_id, values))
        return {
            "status": values["action_status"],
            "updated_at": "2026-09-02T07:00:00+00:00",
            "history": [],
        }

    monkeypatch.setattr(mails_router, "update_mail_sell_action_sync", update)
    response = await mails_router.update_mail_sell_action(
        history_id=91,
        request=mails_router.UpdateMailSellActionRequest(
            status="awaiting_confirmation",
            note="Grouped preview prepared.",
            shares=12.5,
            expected_proceeds=9.75,
        ),
        current_user=SimpleNamespace(id=7),
    )

    assert response.history_id == 91
    assert response.sell_action["status"] == "awaiting_confirmation"
    assert observed == [
        (
            7,
            91,
            {
                "action_status": "awaiting_confirmation",
                "note": "Grouped preview prepared.",
                "market_id": None,
                "shares": 12.5,
                "expected_proceeds": 9.75,
                "proceeds": None,
                "transaction_url": None,
                "error": None,
            },
        )
    ]


@pytest.mark.anyio
async def test_update_mail_sell_action_rejects_invalid_transition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        mails_router,
        "update_mail_sell_action_sync",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            ValueError("Invalid Sell action transition: detected -> filled.")
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await mails_router.update_mail_sell_action(
            history_id=91,
            request=mails_router.UpdateMailSellActionRequest(status="filled"),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 409
    assert "detected -> filled" in str(exc_info.value.detail)
