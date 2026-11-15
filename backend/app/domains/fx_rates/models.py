from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class FxRate(Base, TimestampMixin):
    __tablename__ = "fx_rates"
    __table_args__ = (
        UniqueConstraint(
            "base_currency",
            "quote_currency",
            "source",
            "source_as_of",
            name="uq_fx_rates_pair_source_as_of",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    base_currency: Mapped[str] = mapped_column(String(3), index=True, nullable=False)
    quote_currency: Mapped[str] = mapped_column(String(3), index=True, nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    source_as_of: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        index=True,
        nullable=False,
    )
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
