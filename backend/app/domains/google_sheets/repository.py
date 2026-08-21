from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.domains.google_sheets.models import GoogleSheetsAppConfig, GoogleSheetsCredential


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


class GoogleSheetsAppConfigRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get(self) -> GoogleSheetsAppConfig | None:
        result = await self.db.execute(
            select(GoogleSheetsAppConfig).order_by(
                GoogleSheetsAppConfig.updated_at.desc(),
                GoogleSheetsAppConfig.id.desc(),
            )
        )
        return result.scalars().first()

    async def upsert(
        self,
        client_id: str,
        client_secret_enc: str,
        updated_by_user_id: int | None,
    ) -> GoogleSheetsAppConfig:
        config = await self.get()

        if config:
            config.client_id = client_id
            config.client_secret_enc = client_secret_enc
            config.updated_by_user_id = updated_by_user_id
            self.db.add(config)
        else:
            config = GoogleSheetsAppConfig(
                client_id=client_id,
                client_secret_enc=client_secret_enc,
                updated_by_user_id=updated_by_user_id,
            )
            self.db.add(config)

        await self.db.flush()
        await self.db.refresh(config)
        return config


class GoogleSheetsAppConfigSyncRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self) -> GoogleSheetsAppConfig | None:
        result = self.db.execute(
            select(GoogleSheetsAppConfig).order_by(
                GoogleSheetsAppConfig.updated_at.desc(),
                GoogleSheetsAppConfig.id.desc(),
            )
        )
        return result.scalars().first()
