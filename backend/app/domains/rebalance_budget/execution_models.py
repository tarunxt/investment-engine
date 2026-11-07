"""Durable resource reservations, independent of provider invoice evidence."""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base


class RebalanceExecution(Base):
    __tablename__ = "rebalance_executions"
    __table_args__ = (
        CheckConstraint("output_used >= 0 AND output_reserved >= 0 AND tools_used >= 0 AND tools_reserved >= 0", name="ck_rebalance_execution_counts"),
    )
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="RESTRICT"), primary_key=True)
    scope_id: Mapped[int] = mapped_column(ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False)
    fence_token: Mapped[str | None] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deadline_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    output_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_reserved: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tools_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tools_reserved: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class RebalanceResourceReservation(Base):
    __tablename__ = "rebalance_resource_reservations"
    __table_args__ = (
        UniqueConstraint("job_id", "attempt_key", name="uq_rebalance_resource_attempt"),
        CheckConstraint("output_bound >= 0 AND output_bound <= 12000 AND (output_bound > 0 OR tools_bound > 0) AND tools_bound >= 0 AND tools_bound <= 4", name="ck_rebalance_resource_bounds"),
        CheckConstraint("(output_actual IS NULL OR output_actual >= 0) AND (tools_actual IS NULL OR tools_actual >= 0)", name="ck_rebalance_resource_actuals"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("rebalance_executions.job_id", ondelete="RESTRICT"), nullable=False)
    attempt_key: Mapped[str] = mapped_column(String(128), nullable=False)
    fence_token: Mapped[str] = mapped_column(String(36), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    output_bound: Mapped[int] = mapped_column(Integer, nullable=False)
    tools_bound: Mapped[int] = mapped_column(Integer, nullable=False)
    output_actual: Mapped[int | None] = mapped_column(Integer)
    tools_actual: Mapped[int | None] = mapped_column(Integer)
