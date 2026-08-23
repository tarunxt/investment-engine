from hashlib import sha256

from sqlalchemy import select

from app.domains.auth.models import User
from app.domains.mails.service import (
    MAIL_CATEGORY_ACCOUNT,
    send_logged_email_sync,
)
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
from app.services.email import EmailService


@celery.task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name="app.domains.auth.tasks.send_reset_password_email_task",
    queue="email",
)
def send_reset_password_email_task(self, email: str, token: str) -> None:
    """Send password-reset mail and retain a redacted user-visible audit entry."""
    try:
        with SyncSessionLocal() as session:
            user = session.execute(
                select(User).where(User.email == email).limit(1)
            ).scalar_one_or_none()
            if user is None:
                success = EmailService.send_reset_password_email(email, token)
                if not success:
                    raise RuntimeError("Email send returned failure")
                return

            subject, html_content, text_content = (
                EmailService.build_reset_password_email(token)
            )
            token_fingerprint = sha256(token.encode("utf-8")).hexdigest()[:24]
            delivery = send_logged_email_sync(
                session,
                user_id=int(user.id),
                action="mail.password_reset",
                trigger="Password reset",
                category=MAIL_CATEGORY_ACCOUNT,
                recipients=(email,),
                subject=subject,
                html_content=html_content,
                text_content=text_content,
                audit_message=(
                    "A password-reset link was sent. The security token is "
                    "intentionally hidden from mail history."
                ),
                remarks=(
                    "Automatic account-security email requested from the "
                    "Cred-X password reset flow."
                ),
                idempotency_key=(
                    f"password-reset:{user.id}:{token_fingerprint}:"
                    f"attempt:{self.request.retries}"
                ),
            )
            if not delivery.result.sent:
                raise RuntimeError(
                    "Email send returned failure: "
                    f"{delivery.result.code} — {delivery.result.summary}"
                )
    except Exception as exc:
        raise self.retry(exc=exc)
