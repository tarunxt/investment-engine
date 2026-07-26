from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
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
    __table_args__ = (
        Index(
            "ix_polymarket_auto_live_runs_user_status_started_at",
            "user_id",
            "status",
            "started_at",
        ),
    )

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
    # Bounded console-only projection. The immutable/full execution payload
    # remains in ``payload`` and is loaded only by run-detail or audit paths.
    console_projection: Mapped[dict[str, object] | None] = mapped_column(
        JSON,
        nullable=True,
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()
    decisions: Mapped[list[PolymarketAutoLiveDecisionRecord]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
    )
    order_intents: Mapped[list[PolymarketAutoLiveOrderIntentRecord]] = relationship(
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
    # Removes LLM output and nested stage payloads from frequent dashboard
    # polling while retaining the complete immutable decision in ``payload``.
    console_projection: Mapped[dict[str, object] | None] = mapped_column(
        JSON,
        nullable=True,
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()
    run: Mapped[PolymarketAutoLiveRunRecord] = relationship(back_populates="decisions")
    order_intents: Mapped[list[PolymarketAutoLiveOrderIntentRecord]] = relationship(
        back_populates="decision",
        cascade="all, delete-orphan",
    )


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


class PolymarketAutoLiveOrderIntentRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_order_intents"
    __table_args__ = (
        Index(
            "ix_poly_auto_live_order_intents_status_next_attempt_at",
            "status",
            "next_attempt_at",
        ),
        Index(
            "ix_poly_auto_live_order_intents_run_id",
            "run_id",
        ),
        Index(
            "ix_poly_auto_live_order_intents_user_id",
            "user_id",
        ),
        Index(
            "ix_poly_auto_live_order_intents_decision_id",
            "decision_id",
        ),
        Index(
            "ix_poly_auto_live_order_intents_idempotency_key",
            "idempotency_key",
            unique=True,
        ),
        Index(
            "ix_poly_auto_live_order_intents_remote_order_id",
            "remote_order_id",
        ),
        Index(
            "ix_poly_auto_live_order_intents_dependency_group",
            "dependency_group",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("polymarket_auto_live_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    decision_id: Mapped[str | None] = mapped_column(
        ForeignKey("polymarket_auto_live_decisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    dependency_group: Mapped[str | None] = mapped_column(String(128), nullable=True)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    market_id: Mapped[str] = mapped_column(String(500), nullable=False)
    slug: Mapped[str | None] = mapped_column(String(500), nullable=True)
    condition_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    side: Mapped[str | None] = mapped_column(String(8), nullable=True)
    requested_order_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    requested_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    requested_limit_price_cents: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_order_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    current_limit_price_cents: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_slippage_cents: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    error_class: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retryable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    remote_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    remote_transaction_hash: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    reserved_cash_usd: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    expected_release_usd: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    confirmed_release_usd: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    filled_shares: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    remaining_shares: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    average_fill_price_cents: Mapped[float | None] = mapped_column(Float, nullable=True)
    dependency_metadata_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    execution_metadata_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    first_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    terminal_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    user: Mapped[User] = relationship()
    run: Mapped[PolymarketAutoLiveRunRecord] = relationship(back_populates="order_intents")
    decision: Mapped[PolymarketAutoLiveDecisionRecord | None] = relationship(
        back_populates="order_intents"
    )
    attempts: Mapped[list[PolymarketAutoLiveOrderAttemptRecord]] = relationship(
        back_populates="intent",
        cascade="all, delete-orphan",
        order_by="PolymarketAutoLiveOrderAttemptRecord.attempt_number",
    )
    reservations: Mapped[list[PolymarketAutoLiveCapitalReservationRecord]] = relationship(
        back_populates="order_intent",
        cascade="all, delete-orphan",
    )


class PolymarketAutoLiveOrderAttemptRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_order_attempts"
    __table_args__ = (
        Index(
            "ix_poly_auto_live_order_attempts_intent_attempt_number",
            "intent_id",
            "attempt_number",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    intent_id: Mapped[str] = mapped_column(
        ForeignKey("polymarket_auto_live_order_intents.id", ondelete="CASCADE"),
        nullable=False,
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    worker_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rpc_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    executor_path: Mapped[str | None] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    result_status: Mapped[str] = mapped_column(String(32), nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_after_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    remote_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    remote_transaction_hash: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    sanitized_request_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    sanitized_response_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    reconciliation_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )

    intent: Mapped[PolymarketAutoLiveOrderIntentRecord] = relationship(
        back_populates="attempts"
    )


class PolymarketAutoLiveCapitalReservationRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_auto_live_capital_reservations"
    __table_args__ = (
        Index(
            "ix_poly_auto_live_capital_reservations_user_id_status",
            "user_id",
            "status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    order_intent_id: Mapped[str] = mapped_column(
        ForeignKey("polymarket_auto_live_order_intents.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    amount_usd: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    released_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    user: Mapped[User] = relationship()
    order_intent: Mapped[PolymarketAutoLiveOrderIntentRecord] = relationship(
        back_populates="reservations"
    )
