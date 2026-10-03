"""Scalar snapshot data needed by catalogue cards, without ranking payloads."""

from sqlalchemy import String, case, func, select
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import FunctionElement

from .models import SportsRankingSnapshot


class _JSONType(FunctionElement):
    type = String()
    inherit_cache = True


@compiles(_JSONType)
def _json_type_default(element, compiler, **kwargs):
    return f"json_typeof({compiler.process(element.clauses, **kwargs)})"


@compiles(_JSONType, "sqlite")
def _json_type_sqlite(element, compiler, **kwargs):
    return f"json_type({compiler.process(element.clauses, **kwargs)})"


def snapshot_summaries_query():
    snapshot = SportsRankingSnapshot
    # PostgreSQL's JSON array-length function rejects JSON null and other
    # non-arrays. Only arrays represent ranking rows; SQL/JSON null, objects
    # and scalars contribute no count. Never infer ranks from malformed data.
    ranked_count = case(
        (_JSONType(snapshot.rows) == "array", func.json_array_length(snapshot.rows)),
        else_=0,
    )
    return select(
        snapshot.source_id,
        snapshot.status,
        snapshot.source_url,
        snapshot.source_as_of,
        snapshot.season,
        snapshot.checked_at,
        snapshot.successful_at,
        snapshot.error,
        _JSONType(snapshot.rows).label("rows_type"),
        ranked_count.label("ranked_count"),
    )
