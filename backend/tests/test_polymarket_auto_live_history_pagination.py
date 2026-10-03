"""History pagination must finish before parsing large console JSON values."""

from __future__ import annotations

import asyncio

import app.models  # noqa: F401 - register mapped relationship targets
from sqlalchemy.dialects import postgresql

from app.domains.polymarket_auto_live.repository import AsyncPolymarketAutoLiveRepository


class CaptureHistorySession:
    def __init__(self):
        self.statements = []

    async def scalar(self, statement):
        self.statements.append(statement)
        return 300

    async def execute(self, statement):
        self.statements.append(statement)
        return self

    def all(self):
        return []


def capture_history_query(*, page=5, size=50, workspace_profile=None):
    session = CaptureHistorySession()
    result = asyncio.run(AsyncPolymarketAutoLiveRepository(session).list_run_history_page(
        7, page=page, size=size, workspace_profile=workspace_profile,
    ))
    return session, result


def compile_query(query):
    return str(query.compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True},
    ))


def test_history_limits_scalar_ids_before_parsing_console_json():
    session, result = capture_history_query()
    assert len(session.statements) == 2
    sql = compile_query(session.statements[1])
    assert "history_page AS MATERIALIZED" in sql
    page_query, projection_query = sql.split(")\n SELECT", 1)
    assert "LIMIT 50 OFFSET 200" in page_query
    assert "ORDER BY polymarket_auto_live_runs.started_at DESC" in page_query
    assert "console_projection" not in page_query
    assert "payload" not in page_query
    assert "json_to_record" in projection_query
    assert "JOIN history_page ON" in projection_query
    assert "OFFSET" not in projection_query
    assert result.page == 5
    assert result.pages == 6
    assert result.total == 300
    assert result.size == 50
    assert result.has_next


def test_history_pagination_keeps_owner_and_workspace_filters_inside_the_id_page():
    for workspace_profile in (None, "bullpen007", "bullpen-sports"):
        session, _ = capture_history_query(workspace_profile=workspace_profile)
        count_query = compile_query(session.statements[0])
        page_query = compile_query(session.statements[1]).split(")\n SELECT", 1)[0]
        for sql in (count_query, page_query):
            assert "polymarket_auto_live_runs.user_id = 7" in sql
            if workspace_profile == "bullpen007":
                assert "workspace_profile = 'bullpen007'" in sql
                assert "workspace_profile IS NULL" in sql
            elif workspace_profile == "bullpen-sports":
                assert "workspace_profile = 'bullpen-sports'" in sql
            else:
                assert "workspace_profile" not in sql


def test_history_page_normalization_stays_bounded():
    session, result = capture_history_query(page=0, size=500)
    sql = compile_query(session.statements[1])
    page_query = sql.split(")\n SELECT", 1)[0]
    assert "LIMIT 50 OFFSET 0" in page_query
    assert result.page == 1
    assert result.size == 50
