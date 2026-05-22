from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.google_sheets.models import GoogleSheetsCredential


class GoogleSheetsCredentialRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_user(self, user_id: int) -> GoogleSheetsCredential | None:
        result = await self.db.execute(
            select(GoogleSheetsCredential).where(
                GoogleSheetsCredential.user_id == user_id
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        user_id: int,
        access_token_enc: str,
        refresh_token_enc: str | None,
        token_expiry,
    ) -> GoogleSheetsCredential:
        cred = await self.get_by_user(user_id)

        if cred:
            cred.access_token_enc = access_token_enc
            cred.refresh_token_enc = refresh_token_enc
            cred.token_expiry = token_expiry
            self.db.add(cred)
        else:
            cred = GoogleSheetsCredential(
                user_id=user_id,
                access_token_enc=access_token_enc,
                refresh_token_enc=refresh_token_enc,
                token_expiry=token_expiry,
            )
            self.db.add(cred)

        await self.db.flush()
        await self.db.refresh(cred)
        return cred

    async def delete_by_user(self, user_id: int) -> None:
        cred = await self.get_by_user(user_id)
        if cred:
            await self.db.delete(cred)
            await self.db.flush()
