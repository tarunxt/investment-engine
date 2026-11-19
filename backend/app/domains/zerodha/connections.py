"""Owner-scoped broker profiles for the existing Kite credential lifecycle."""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.auth.models import User
from app.domains.zerodha.audit import ZerodhaAuditLog
from app.domains.zerodha.crypto import decrypt_token, encrypt_token
from app.domains.zerodha.models import ZerodhaCredential
from app.domains.zerodha.repository import ZerodhaCredentialRepository, token_for_credential
from app.domains.zerodha.schemas import KiteBrokerConnection, KiteBrokerProfile
from app.domains.zerodha.service import KiteError, ZerodhaService

logger = logging.getLogger(__name__)
PROFILE_EVENT = "broker_profile"


def utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def readable_token(cred: ZerodhaCredential | None) -> str | None:
    if cred is None:
        return None
    try:
        return token_for_credential(cred)
    except (ValueError, RuntimeError):
        logger.warning("Stored Kite session needs reconnecting for owner %s", cred.user_id)
        return None


def connection_revision(owner: int, cred: ZerodhaCredential | None) -> str:
    # Ciphertext rotates for each successful exchange, including renewals.
    value = cred.access_token if cred else "unlinked"
    return hashlib.sha256(f"{owner}:{value}".encode()).hexdigest()


def check_revision(owner: int, cred: ZerodhaCredential | None, expected: str | None) -> None:
    if expected is not None and connection_revision(owner, cred) != expected:
        raise HTTPException(409, "Your broker connection changed. Refresh Connected Brokers and try again.")


async def lock_connection(db: AsyncSession, owner: int) -> ZerodhaCredential | None:
    # The owner row also serializes first connect and reconnect after removal.
    await db.execute(select(User.id).where(User.id == owner).with_for_update())
    return await ZerodhaCredentialRepository(db).get_stored(owner)


def broker_profile(data: dict) -> KiteBrokerProfile | None:
    client = data.get("user_id")
    if not isinstance(client, str) or not client.strip():
        return None
    def string(key: str) -> str | None:
        value = data.get(key)
        return value.strip() if isinstance(value, str) and value.strip() else None

    def strings(key: str) -> list[str]:
        items = data.get(key)
        return [v for v in items if isinstance(v, str) and v] if isinstance(items, list) else []

    pan = string("pan")
    return KiteBrokerProfile(
        client_id=client.strip().upper(), name=string("user_name"), email=string("email"),
        masked_pan=f"••••••{pan[-4:]}" if pan and len(pan) == 10 else None,
        exchanges=strings("exchanges"), products=strings("products"),
    )


async def _profile_event(db: AsyncSession, owner: int, key: str, value: str) -> ZerodhaAuditLog | None:
    stmt = select(ZerodhaAuditLog).where(
        ZerodhaAuditLog.user_id == owner, ZerodhaAuditLog.action == PROFILE_EVENT,
        ZerodhaAuditLog.details[key].as_string() == value,
    ).order_by(ZerodhaAuditLog.id.desc()).limit(1)
    return await db.scalar(stmt)


async def save_profile(db: AsyncSession, owner: int, cred: ZerodhaCredential,
                       profile: KiteBrokerProfile, first_added: datetime, *, legacy_date: bool = False) -> ZerodhaAuditLog:
    # Caller holds the owner lock. One entry per verified account preserves its
    # first link across daily token renewals, removal and later re-linking.
    account = hashlib.sha256(f"{owner}:{profile.client_id}".encode()).hexdigest()
    row = await _profile_event(db, owner, "account", account)
    if row is None:
        row = ZerodhaAuditLog(user_id=owner, action=PROFILE_EVENT, created_at=utc(first_added))
        db.add(row)
    date_from_record = (row.details or {}).get("legacy_date", legacy_date)
    row.details = {"account": account, "revision": connection_revision(owner, cred), "legacy_date": date_from_record,
                   "profile": encrypt_token(profile.model_dump_json())}
    return row


async def read_connection(db: AsyncSession, owner: int, service: ZerodhaService) -> KiteBrokerConnection:
    cred = await ZerodhaCredentialRepository(db).get_stored(owner)
    revision = connection_revision(owner, cred)
    app = settings.zerodha_personal_apps.get(owner)
    info = KiteBrokerConnection(revision=revision, linked=cred is not None,
                                assigned_client_id=app.client_id if app else None)
    if cred is None:
        return info
    info.connection_record_created_at = utc(cred.created_at)
    info.login_time, info.expires_at = utc(cred.login_time), utc(cred.expires_at)
    token = readable_token(cred)
    info.session_active = bool(token) and info.expires_at > datetime.now(timezone.utc)
    row = await _profile_event(db, owner, "revision", revision)
    if row:
        if row.details.get("legacy_date"):
            info.connection_record_created_at = utc(row.created_at)
        else:
            info.first_added_at = utc(row.created_at)
        try:
            info.profile = KiteBrokerProfile.model_validate_json(decrypt_token(row.details["profile"]))
        except (ValueError, RuntimeError):
            logger.warning("Stored Kite profile needs refreshing for owner %s", owner)
    if info.profile is None and token and info.session_active:
        # Credentials issued before the settings page have no saved profile.
        try:
            profile = broker_profile(await service.get_profile(token))
        except KiteError as exc:
            if exc.error_type == "TokenException":
                info.session_active = False
            profile = None
        except httpx.HTTPError:
            logger.warning("Kite profile temporarily unavailable for owner %s", owner)
            profile = None
        if profile:
            current = await lock_connection(db, owner)
            check_revision(owner, current, revision)
            row = await save_profile(db, owner, cred, profile, utc(cred.created_at), legacy_date=True)
            info.profile = profile
            if row.details.get("legacy_date"):
                info.connection_record_created_at = utc(row.created_at)
            else:
                info.first_added_at = utc(row.created_at)
            await db.commit()
    if info.profile is None and token and app:
        info.profile = KiteBrokerProfile(client_id=app.client_id)
    return info
