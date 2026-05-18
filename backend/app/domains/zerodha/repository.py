from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.zerodha.crypto import decrypt_token, encrypt_token
from app.domains.zerodha.models import ZerodhaCredential


class ZerodhaCredentialRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get_by_user(self, user_id: int) -> ZerodhaCredential | None:
        result = await self._db.execute(
            select(ZerodhaCredential).where(ZerodhaCredential.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def get_plaintext_token(self, user_id: int) -> str | None:
        """Return the decrypted access token and stamp last_used_at."""
        cred = await self.get_by_user(user_id)
        if not cred:
            return None
        cred.last_used_at = datetime.now(tz=timezone.utc)
        await self._db.flush()
        return decrypt_token(cred.access_token)

    async def upsert(
        self,
        user_id: int,
        access_token: str,
        login_time: datetime,
        expires_at: datetime,
    ) -> ZerodhaCredential:
        encrypted = encrypt_token(access_token)
        cred = await self.get_by_user(user_id)
        if cred:
            cred.access_token = encrypted
            cred.login_time = login_time
            cred.expires_at = expires_at
        else:
            cred = ZerodhaCredential(
                user_id=user_id,
                access_token=encrypted,
                login_time=login_time,
                expires_at=expires_at,
            )
            self._db.add(cred)
        await self._db.flush()
        return cred

    async def delete_by_user(self, user_id: int) -> None:
        await self._db.execute(
            delete(ZerodhaCredential).where(ZerodhaCredential.user_id == user_id)
        )
