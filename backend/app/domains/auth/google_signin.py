"""Google identity verification. No OAuth client secret or Google API scopes needed."""

import os

from fastapi import HTTPException
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request
from google.oauth2 import id_token
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.google_sheets.models import GoogleSheetsAppConfig


async def google_signin_client_id(db: AsyncSession) -> str | None:
    # A dedicated public client ID can override the existing Google integration.
    configured = os.getenv("GOOGLE_SIGNIN_CLIENT_ID", "").strip()
    if configured:
        return configured
    # Select only the public ID; never read/decrypt the Sheets client secret.
    result = await db.execute(
        select(GoogleSheetsAppConfig.client_id)
        .order_by(GoogleSheetsAppConfig.updated_at.desc(), GoogleSheetsAppConfig.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none() or settings.google_client_id or None


class _BoundedGoogleRequest(Request):
    def __call__(self, *args, **kwargs):
        kwargs["timeout"] = 5
        return super().__call__(*args, **kwargs)


def verify_google_identity(credential: str, client_id: str | None) -> str:
    if not client_id:
        raise HTTPException(503, "Google sign-in is not configured")
    try:
        claims = id_token.verify_oauth2_token(
            credential, _BoundedGoogleRequest(), audience=client_id
        )
    except (ValueError, GoogleAuthError):
        # Do not log bearer credentials or Google's raw exception payload.
        raise HTTPException(401, "Google sign-in could not be verified") from None

    email = claims.get("email")
    if (
        not claims.get("sub")
        or claims.get("email_verified") is not True
        or not isinstance(email, str)
        or "@" not in email
    ):
        raise HTTPException(401, "Google sign-in could not be verified")
    # Google is not authoritative for third-party email addresses without hd.
    # Never grant access to an existing account based on such an email alone.
    email = email.strip().lower()
    if not email.endswith("@gmail.com") and not claims.get("hd"):
        raise HTTPException(403, "Use password sign-in for this email address")
    return email


def require_existing_google_user(matches):
    """Do not create accounts, change roles, or reactivate disabled users."""
    if len(matches) != 1 or not matches[0].is_active:
        raise HTTPException(401, "Google sign-in is unavailable for this account")
    return matches[0]
