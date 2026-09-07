from sqlalchemy import JSON, Column, Integer, Table, MetaData, select
from sqlalchemy.dialects import postgresql
from app.domains.polymarket_auto_live.trend_snapshot import (
    frozen_trend_stages, needs_frozen_trend_overlay,
)


def test_complete_stage_one_does_not_read_full_universe_for_trends():
    stages = [{"outputs": {"workflow_stage_key": "scan",
        "accepted_candidates_count": 80, "accepted_candidates": [{}] * 80}}]
    assert not needs_frozen_trend_overlay(stages)
    stages[0]["outputs"]["accepted_candidates_count"] = 81
    assert needs_frozen_trend_overlay(stages)


def test_legacy_llm_coverage_still_gets_frozen_overlay():
    stages = [{"outputs": {"llm_reviewed_candidates": [{"market_id": "one"}]}}]
    assert needs_frozen_trend_overlay(stages)
    stages[0]["outputs"]["llm_reviewed_candidates"][0]["llm_outputs"] = [{"error": "provider error"}]
    assert not needs_frozen_trend_overlay(stages)


def test_overlay_sql_selects_candidates_without_rejected_scan_or_inputs():
    from sqlalchemy.orm import DeclarativeBase
    class Base(DeclarativeBase):
        pass
    class Record(Base):
        __tablename__ = "runs"
        id = Column(Integer, primary_key=True)
        payload = Column(JSON)
    query = select(frozen_trend_stages(Record)).where(Record.id == 1)
    sql = str(query.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "accepted_candidates" in sql and "llm_reviewed_candidates" in sql
    assert "rejected_candidates" not in sql and "scan_export_data" not in sql
    assert "ORDER BY trend_stage.ordinality" in sql
    assert sql.count("FROM runs") == 1
