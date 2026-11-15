from datetime import datetime

from sqlalchemy import DateTime, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base


class SportsRankingSnapshot(Base):
    __tablename__ = "sports_ranking_snapshots"

    source_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    rows: Mapped[list] = mapped_column(JSON, default=list)
    source_url: Mapped[str | None] = mapped_column(Text)
    source_as_of: Mapped[str | None] = mapped_column(String(40))
    season: Mapped[str | None] = mapped_column(String(40))
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    successful_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content_hash: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
