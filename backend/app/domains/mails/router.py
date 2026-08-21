from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, EmailStr

from app.core.config import settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.services.email import EmailService

router = APIRouter(prefix="/mails", tags=["mails"])

TEST_RECIPIENTS = ("tarun.singh6893@gmail.com",)
TEST_SUBJECT = "Message from Tarun's Cred-X"
TEST_MESSAGE = "Hi, this a message from Tarun's Cred-X"


class SendTestMailResponse(BaseModel):
    sent: bool
    recipients: list[EmailStr]
    message: str


def _safe_smtp_config() -> dict[str, object]:
    return {
        "host": settings.smtp_host or "(not set)",
        "port": settings.smtp_port,
        "username_configured": bool(settings.smtp_user),
        "password_configured": bool(settings.smtp_password),
        "from_email": settings.smtp_from_email,
        "from_name": settings.smtp_from_name,
    }


@router.post("/send-test", response_model=SendTestMailResponse)
async def send_test_mail(
    current_user: User = Depends(get_current_user),
) -> SendTestMailResponse:
    """Send the initial fixed Cred-X message to the server-approved recipients."""
    for recipient in TEST_RECIPIENTS:
        result = await run_in_threadpool(
            EmailService.send_email_detailed,
            recipient,
            TEST_SUBJECT,
            f"<p>{TEST_MESSAGE}</p>",
            TEST_MESSAGE,
        )
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
                },
            )

    return SendTestMailResponse(
        sent=True,
        recipients=list(TEST_RECIPIENTS),
        message=TEST_MESSAGE,
    )
