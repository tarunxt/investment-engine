from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint, event, inspect
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class IndMoneyUsPortfolioSnapshot(Base, TimestampMixin):
    __tablename__ = "indmoney_us_portfolio_snapshots"

    __table_args__ = (UniqueConstraint('user_id','import_key',name='uq_indmoney_owner_import'),)

    acceptance_state: Mapped[str] = mapped_column(String(24),nullable=False,default='legacy_unverified',server_default='legacy_unverified')
    import_key: Mapped[str | None] = mapped_column(String(64),nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64),nullable=True)
    import_provenance: Mapped[dict | None] = mapped_column(JSON,nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),nullable=True)
    supersedes_id: Mapped[int | None] = mapped_column(ForeignKey('indmoney_us_portfolio_snapshots.id',ondelete='RESTRICT'),nullable=True)

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


@event.listens_for(IndMoneyUsPortfolioSnapshot,'before_update')
def immutable_import(mapper, connection, target):
    state=inspect(target)
    # Financial payload/provenance are immutable even while previewed. Acceptance
    # uses a scoped compare-and-set; corrections always create another row.
    allowed={'acceptance_state','accepted_at','updated_at'}
    if any(a.history.has_changes() for a in state.attrs if a.key not in allowed):
        raise ValueError('Import snapshots are immutable; create a correction version')


@event.listens_for(IndMoneyUsPortfolioSnapshot,'before_delete')
def retain_import(mapper, connection, target):
    raise ValueError('Import history cannot be deleted; create a correction version')
