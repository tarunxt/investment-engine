from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.domains.auth.models import User


class PolymarketAutoLiveSettingsRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_settings"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()


class PolymarketAutoLiveStateRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_states"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    running: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="not-configured", nullable=False)
    mode: Mapped[str] = mapped_column(String(32), default="dry-run", nullable=False)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()


class PolymarketAutoLiveRunRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    triggered_by: Mapped[str] = mapped_column(String(32), nullable=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    live_execution_requested: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    live_execution_attempted: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    decisions_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_planned: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_submitted: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()
    decisions: Mapped[list[PolymarketAutoLiveDecisionRecord]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
    )


class PolymarketAutoLiveDecisionRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_decisions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("polymarket_auto_live_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    market_id: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    slug: Mapped[str | None] = mapped_column(String(500), nullable=True, index=True)
    market_title: Mapped[str] = mapped_column(Text, nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    decision: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    risk_status: Mapped[str] = mapped_column(String(32), nullable=False)
    edge_pp: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    score: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()
    run: Mapped[PolymarketAutoLiveRunRecord] = relationship(back_populates="decisions")


class PolymarketAutoLivePositionRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    market_id: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    slug: Mapped[str | None] = mapped_column(String(500), nullable=True, index=True)
    market_title: Mapped[str] = mapped_column(Text, nullable=False)
    market_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    theme: Mapped[str] = mapped_column(String(255), nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    exposure_usd: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    shares: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    average_price_cents: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()
