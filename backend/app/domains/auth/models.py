from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Column, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.domains.jobs.models import Job
    from app.domains.prompts.models import Prompt


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    USER = "user"
    VIEWER = "viewer"


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.USER, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_login: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reset_password_token: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    reset_password_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    profile: Mapped[UserProfile] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    sessions: Mapped[list[UserSession]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    api_keys: Mapped[list[APIKey]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    jobs: Mapped[list[Job]] = relationship(back_populates="user", cascade="all, delete-orphan")
    activity_logs: Mapped[list[ActivityLog]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    prompts: Mapped[list[Prompt]] = relationship(
        "Prompt", back_populates="user", foreign_keys="[Prompt.user_id]"
    )

    def __repr__(self) -> str:
        return f"<User {self.email}>"


class UserProfile(Base, TimestampMixin):
    __tablename__ = "user_profiles"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    timezone: Mapped[str] = mapped_column(String(50), default="UTC", nullable=False)
    notification_preferences: Mapped[str] = mapped_column(String(500), default="all", nullable=False)
    theme_preference: Mapped[str] = mapped_column(String(20), default="light", nullable=False)
    zerodha_buy_threshold: Mapped[float] = mapped_column(Float, default=2.5, nullable=False)
    indmoney_buy_threshold: Mapped[float] = mapped_column(Float, default=2.5, nullable=False)
    google_sheets_master_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    user: Mapped[User] = relationship(back_populates="profile")


class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    token_hash = Column(String(255), nullable=False)
    ip_address = Column(String(50), nullable=True)
    user_agent = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    last_activity = Column(DateTime, default=datetime.utcnow, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)

    user = relationship("User", back_populates="sessions")


class APIKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    key = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(255), nullable=False)
    key_hash = Column(String(255), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="api_keys")


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    action = Column(String(100), nullable=False)
    resource_type = Column(String(50), nullable=True)
    resource_id = Column(Integer, nullable=True)
    details = Column(Text, nullable=True)
    ip_address = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    user = relationship("User", back_populates="activity_logs")
