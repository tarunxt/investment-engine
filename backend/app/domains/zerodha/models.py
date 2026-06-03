from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class ZerodhaCredential(Base, TimestampMixin):
    __tablename__ = "zerodha_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )
    access_token: Mapped[str] = mapped_column(Text, nullable=False)  # stored encrypted
    login_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ZerodhaPortfolioSnapshot(Base, TimestampMixin):
    __tablename__ = "zerodha_portfolio_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "snapshot_date",
            name="uq_zerodha_portfolio_snapshots_user_date",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    snapshot_date: Mapped[date] = mapped_column(Date, index=True, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="manual")

    holdings_count: Mapped[int] = mapped_column(nullable=False, default=0)
    net_positions_count: Mapped[int] = mapped_column(nullable=False, default=0)
    day_positions_count: Mapped[int] = mapped_column(nullable=False, default=0)

    holdings_market_value: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    holdings_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    holdings_day_change_value: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    available_margin: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    positions_pnl: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    positions_m2m: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    holdings: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    net_positions: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    day_positions: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
