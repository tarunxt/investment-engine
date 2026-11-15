from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, Float, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class IndMoneyUsPortfolioSnapshot(Base, TimestampMixin):
    __tablename__ = "indmoney_us_portfolio_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    snapshot_date: Mapped[date] = mapped_column(Date, index=True, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True, nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="manual_paste")

    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    parse_status: Mapped[str] = mapped_column(String(32), nullable=False, default="parsed")
    parse_warnings: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)

    holdings_count: Mapped[int] = mapped_column(nullable=False, default=0)
    reported_holdings_count: Mapped[int | None] = mapped_column(nullable=True)
    indices_count: Mapped[int] = mapped_column(nullable=False, default=0)

    wallet_balance: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    invested_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    day_return_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    day_return_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_return_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_return_percent: Mapped[float | None] = mapped_column(Float, nullable=True)

    market_indices: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    dashboard_top_holdings: Mapped[list[dict]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
    )
    holdings: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
