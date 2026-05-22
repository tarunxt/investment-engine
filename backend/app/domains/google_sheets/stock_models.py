from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.domains.auth.models import User
    from app.domains.jobs.models import Job


class StockRecommendation(Base, TimestampMixin):
    """Stores parsed stock recommendations from AI job results."""

    __tablename__ = "stock_recommendations"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[int | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )

    stock_name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    technical_setup: Mapped[str | None] = mapped_column(Text, nullable=True)
    entry_range: Mapped[str | None] = mapped_column(String(100), nullable=True)
    stop_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    target: Mapped[float | None] = mapped_column(Float, nullable=True)
    analyst_source: Mapped[str | None] = mapped_column(String(100), nullable=True)
    units_to_buy: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_per_unit: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_buy_amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    upside_horizon: Mapped[str | None] = mapped_column(String(100), nullable=True)
    confidence_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    rationale_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship()
    job: Mapped["Job"] = relationship()
