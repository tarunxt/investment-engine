from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy import true as sa_true
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.infrastructure.database.base import Base
from app.domains.auth.models import User


class UserModulePreferences(Base):
    """One atomic version for an owner's complete optional selection set."""
    __tablename__ = 'user_module_preferences'
    __table_args__ = (CheckConstraint('version >= 0', name='ck_user_module_preferences_version'),)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    user: Mapped[User] = relationship()


class UserModule(Base):
    __tablename__ = 'user_modules'
    __table_args__ = (UniqueConstraint('user_id', 'module_id', name='uq_user_module_owner_id'),
                     CheckConstraint('version > 0', name='ck_user_module_version'))
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('user_module_preferences.user_id', ondelete='CASCADE'), index=True)
    module_id: Mapped[str] = mapped_column(String(40), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    schedules_paused: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=sa_true())
    preferences: Mapped[UserModulePreferences] = relationship()
