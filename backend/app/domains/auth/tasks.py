from app.infrastructure.messaging.celery_app import celery


@celery.task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name="app.domains.auth.tasks.send_reset_password_email_task",
    queue="email",
)
def send_reset_password_email_task(self, email: str, token: str) -> None:
    from app.services.email import EmailService

    try:
        success = EmailService.send_reset_password_email(email, token)
        if not success:
            raise RuntimeError("Email send returned failure")
    except Exception as exc:
        raise self.retry(exc=exc)
