from __future__ import annotations
from datetime import datetime
from typing import Any
from sqlalchemy import DateTime, Float, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.infrastructure.database.base import Base, TimestampMixin

class CostSnapshot(Base, TimestampMixin):
    __tablename__ = "cost_snapshots"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    source: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    period_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    service: Mapped[str | None] = mapped_column(String(255), nullable=True)
    usage_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    operation: Mapped[str | None] = mapped_column(String(255), nullable=True)
    region: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    usage_quantity: Mapped[float | None] = mapped_column(Float, nullable=True)
    usage_unit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actual_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    estimated_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

class TrafficCostRollup(Base, TimestampMixin):
    __tablename__ = "traffic_cost_rollups"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    period_start: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    period_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(255), nullable=True)
    extension: Mapped[str | None] = mapped_column(String(32), nullable=True)
    request_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    response_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_hit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bot_request_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    top_user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    estimated_transfer_cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)

class CostRecommendation(Base, TimestampMixin):
    __tablename__ = "cost_recommendations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    driver_key: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    suggested_action: Mapped[str] = mapped_column(Text, nullable=False)
    estimated_monthly_savings_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[str] = mapped_column(String(32), nullable=False)
    evidence_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
