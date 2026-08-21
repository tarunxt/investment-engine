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


@router.post("/send-test", response_model=SendTestMailResponse)
async def send_test_mail(
    current_user: User = Depends(get_current_user),
) -> SendTestMailResponse:
    """Send the initial fixed Cred-X message to the server-approved recipients."""
    if not settings.smtp_host:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Mail is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM_EMAIL, and SMTP_FROM_NAME to the backend environment.",
        )

    for recipient in TEST_RECIPIENTS:
        sent = await run_in_threadpool(
            EmailService.send_email,
            recipient,
            TEST_SUBJECT,
            f"<p>{TEST_MESSAGE}</p>",
            TEST_MESSAGE,
        )
        if not sent:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The mail provider rejected the message. Check the backend SMTP configuration and logs.",
            )

    return SendTestMailResponse(
        sent=True,
        recipients=list(TEST_RECIPIENTS),
        message=TEST_MESSAGE,
    )
