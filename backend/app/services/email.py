import smtplib
import socket
from dataclasses import dataclass
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class EmailSendResult:
    sent: bool
    code: str
    summary: str
    provider_message: str | None = None
    how_to_fix: tuple[str, ...] = ()


def _safe_provider_message(value: object) -> str:
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="replace")
    else:
        text = str(value)
    text = " ".join(text.split())
    password = settings.smtp_password or ""
    if password:
        text = text.replace(password, "[REDACTED]")
    return text[:500]


def _failure(
    code: str,
    summary: str,
    *,
    provider_message: object | None = None,
    how_to_fix: tuple[str, ...],
) -> EmailSendResult:
    return EmailSendResult(
        sent=False,
        code=code,
        summary=summary,
        provider_message=(
            _safe_provider_message(provider_message)
            if provider_message is not None
            else None
        ),
        how_to_fix=how_to_fix,
    )


class EmailService:
    @staticmethod
    def send_email_detailed(
        email_to: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None,
    ) -> EmailSendResult:
        """Send an email and return safe, actionable SMTP diagnostics."""
        if not settings.smtp_host:
            return _failure(
                "SMTP_NOT_CONFIGURED",
                "No SMTP server is configured.",
                how_to_fix=(
                    "Set SMTP_HOST and SMTP_PORT in /etc/investor/backend.env.",
                    "Set SMTP_USER, SMTP_PASSWORD, SMTP_FROM_EMAIL and SMTP_FROM_NAME.",
                    "Restart investor-backend after changing the environment file.",
                ),
            )

        if bool(settings.smtp_user) != bool(settings.smtp_password):
            return _failure(
                "SMTP_CREDENTIALS_INCOMPLETE",
                "Only one of SMTP_USER and SMTP_PASSWORD is configured.",
                how_to_fix=(
                    "Set both SMTP_USER and SMTP_PASSWORD in /etc/investor/backend.env.",
                    "Restart investor-backend and try again.",
                ),
            )

        from_email = settings.smtp_from_email.strip()
        if (
            not from_email
            or from_email.endswith("@example.com")
            or from_email.endswith("@yourdomain.com")
            or "<" in from_email
            or ">" in from_email
        ):
            return _failure(
                "SMTP_SENDER_PLACEHOLDER",
                f"The configured sender address '{from_email or '(empty)'}' is not a real verified sender.",
                how_to_fix=(
                    "Set SMTP_FROM_EMAIL to an address verified by the SMTP provider.",
                    "For Gmail SMTP, use the same Gmail address as SMTP_USER.",
                    "Restart investor-backend after changing /etc/investor/backend.env.",
                ),
            )

        if settings.smtp_password and (
            settings.smtp_password.startswith("<")
            or settings.smtp_password.lower() in {"change-me", "changeme", "password"}
        ):
            return _failure(
                "SMTP_PASSWORD_PLACEHOLDER",
                "SMTP_PASSWORD still contains a placeholder instead of a provider credential.",
                how_to_fix=(
                    "Replace SMTP_PASSWORD with a real SMTP credential.",
                    "For Gmail, enable two-step verification and use a 16-character App Password—not the normal account password.",
                    "Restart investor-backend and try again.",
                ),
            )

        message = MIMEMultipart("alternative")
        message["Subject"] = subject
        message["From"] = f"{settings.smtp_from_name} <{from_email}>"
        message["To"] = email_to

        if text_content:
            message.attach(MIMEText(text_content, "plain"))
        message.attach(MIMEText(html_content, "html"))

        try:
            port = settings.smtp_port or 587
            smtp_factory = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
            with smtp_factory(settings.smtp_host, port, timeout=20) as server:
                if port != 465:
                    server.ehlo()
                    if server.has_extn("STARTTLS"):
                        server.starttls()
                        server.ehlo()
                if settings.smtp_user and settings.smtp_password:
                    server.login(settings.smtp_user, settings.smtp_password)
                server.sendmail(from_email, [email_to], message.as_string())
            logger.info("Email sent to %s", email_to)
            return EmailSendResult(
                sent=True,
                code="EMAIL_SENT",
                summary="Email accepted by the SMTP provider.",
            )
        except smtplib.SMTPAuthenticationError as exc:
            result = _failure(
                "SMTP_AUTHENTICATION_FAILED",
                "The SMTP server rejected the username or password.",
                provider_message=exc.smtp_error,
                how_to_fix=(
                    "Verify SMTP_USER and SMTP_PASSWORD in /etc/investor/backend.env.",
                    "For Gmail, use a 16-character App Password; the normal Gmail password will be rejected.",
                    "For SendGrid, SMTP_USER must be 'apikey' and SMTP_PASSWORD must be the SendGrid API key.",
                    "Restart investor-backend after correcting the credentials.",
                ),
            )
        except smtplib.SMTPSenderRefused as exc:
            result = _failure(
                "SMTP_SENDER_REJECTED",
                f"The provider rejected the sender address '{from_email}'.",
                provider_message=exc.smtp_error,
                how_to_fix=(
                    "Verify this sender address or its domain in the mail provider.",
                    "Set SMTP_FROM_EMAIL to the verified address.",
                    "For Gmail, make SMTP_FROM_EMAIL match SMTP_USER.",
                ),
            )
        except smtplib.SMTPRecipientsRefused as exc:
            provider_message = next(iter(exc.recipients.values()), "Recipient refused")
            result = _failure(
                "SMTP_RECIPIENT_REJECTED",
                f"The provider rejected the recipient '{email_to}'.",
                provider_message=provider_message,
                how_to_fix=(
                    "Confirm the recipient address is correct.",
                    "If the provider account is in sandbox mode, verify the recipient or request production access.",
                ),
            )
        except smtplib.SMTPNotSupportedError as exc:
            result = _failure(
                "SMTP_SECURITY_NOT_SUPPORTED",
                "The SMTP server does not support the required authentication or encryption mode.",
                provider_message=exc,
                how_to_fix=(
                    "Use port 587 for STARTTLS or port 465 for implicit TLS.",
                    "Confirm the SMTP host and port with the provider.",
                ),
            )
        except (smtplib.SMTPConnectError, socket.timeout, TimeoutError, OSError) as exc:
            result = _failure(
                "SMTP_CONNECTION_FAILED",
                "Cred-X could not connect to the configured SMTP server.",
                provider_message=exc,
                how_to_fix=(
                    "Check SMTP_HOST and SMTP_PORT.",
                    "Confirm the production server allows outbound traffic to that port.",
                    "Use port 587 or 465 if port 25 is blocked.",
                ),
            )
        except smtplib.SMTPResponseException as exc:
            result = _failure(
                f"SMTP_PROVIDER_ERROR_{exc.smtp_code}",
                "The SMTP provider rejected the delivery request.",
                provider_message=exc.smtp_error,
                how_to_fix=(
                    "Use the provider response below to correct the account, sender, relay or quota setting.",
                    "Check /etc/investor/backend.env and restart investor-backend after making changes.",
                ),
            )
        except smtplib.SMTPException as exc:
            result = _failure(
                "SMTP_PROTOCOL_ERROR",
                "The SMTP conversation failed.",
                provider_message=exc,
                how_to_fix=(
                    "Confirm the SMTP host, port, authentication and TLS settings with the provider.",
                    "Check the investor-backend logs for the same diagnostic code.",
                ),
            )
        except Exception as exc:
            result = _failure(
                "EMAIL_SEND_UNEXPECTED_ERROR",
                "An unexpected error occurred while sending the email.",
                provider_message=type(exc).__name__,
                how_to_fix=(
                    "Check investor-backend logs using the displayed diagnostic code.",
                    "Confirm all SMTP_* settings and restart investor-backend.",
                ),
            )

        logger.error(
            "Email delivery failed code=%s recipient=%s provider_message=%s",
            result.code,
            email_to,
            result.provider_message,
        )
        return result

    @staticmethod
    def send_email(
        email_to: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None,
    ) -> bool:
        """Backward-compatible boolean wrapper used by existing callers."""
        return EmailService.send_email_detailed(
            email_to=email_to,
            subject=subject,
            html_content=html_content,
            text_content=text_content,
        ).sent

    @staticmethod
    def build_reset_password_email(token: str) -> tuple[str, str, str]:
        """Build the password-reset subject and bodies for audited delivery."""
        project_name = settings.app_name
        subject = f"{project_name} - Password Reset"
        reset_link = f"{settings.frontend_url}/reset-password/{token}"

        html_content = f"""
        <html>
            <body>
                <p>Hello,</p>
                <p>You requested a password reset for your account on {project_name}.</p>
                <p>Please click the link below to reset your password. This link will expire in 1 hour.</p>
                <p><a href="{reset_link}">{reset_link}</a></p>
                <p>If you did not request this, please ignore this email.</p>
                <p>Best regards,<br>{project_name} Team</p>
            </body>
        </html>
        """

        text_content = f"""
        Hello,

        You requested a password reset for your account on {project_name}.

        Please click the link below to reset your password. This link will expire in 1 hour.

        {reset_link}

        If you did not request this, please ignore this email.

        Best regards,
        {project_name} Team
        """

        return subject, html_content, text_content

    @staticmethod
    def send_reset_password_email(email_to: str, token: str) -> bool:
        """Backward-compatible password reset sender."""
        subject, html_content, text_content = EmailService.build_reset_password_email(token)
        return EmailService.send_email(
            email_to=email_to,
            subject=subject,
            html_content=html_content,
            text_content=text_content,
        )
