import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Any, Dict, Optional
from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

class EmailService:
    @staticmethod
    def send_email(
        email_to: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None
    ) -> bool:
        """Send an email using SMTP."""
        
        if not settings.smtp_host:
            logger.warning("SMTP host not configured, skipping email sending")
            logger.info(f"Email that would have been sent to {email_to}:")
            logger.info(f"Subject: {subject}")
            logger.info(f"Content: {html_content[:100]}...")
            return True

        message = MIMEMultipart("alternative")
        message["Subject"] = subject
        message["From"] = f"{settings.emails_from_name} <{settings.emails_from_email}>"
        message["To"] = email_to

        if text_content:
            part1 = MIMEText(text_content, "plain")
            message.attach(part1)
        
        part2 = MIMEText(html_content, "html")
        message.attach(part2)

        try:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
                if settings.smtp_user and settings.smtp_password:
                    server.starttls()
                    server.login(settings.smtp_user, settings.smtp_password)
                server.sendmail(
                    settings.emails_from_email, email_to, message.as_string()
                )
            logger.info(f"Email sent to {email_to}")
            return True
        except Exception as e:
            logger.error(f"Error sending email to {email_to}: {str(e)}")
            return False

    @staticmethod
    def send_reset_password_email(email_to: str, token: str) -> bool:
        """Send a password reset email."""
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
        
        return EmailService.send_email(
            email_to=email_to,
            subject=subject,
            html_content=html_content,
            text_content=text_content
        )
