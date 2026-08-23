from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class DashboardPortfolioDailySnapshot(Base, TimestampMixin):
    __tablename__ = "dashboard_portfolio_daily_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "snapshot_date",
            name="uq_dashboard_portfolio_daily_snapshots_user_date",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    snapshot_date: Mapped[date] = mapped_column(Date, index=True, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    usd_inr_rate: Mapped[float | None] = mapped_column(Float, nullable=True)

    zerodha_total_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
    zerodha_source_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    zerodha_carried_forward: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )

    indmoney_total_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    indmoney_total_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
    indmoney_source_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    indmoney_carried_forward: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )

    bullpen_total_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    bullpen_total_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
    combined_total_inr: Mapped[float | None] = mapped_column(Float, nullable=True)
