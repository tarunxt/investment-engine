from datetime import datetime, timezone

from app.domains.runs.final_actionable_history import (
    decode_history_cursor,
    encode_history_cursor,
    normalize_action,
    normalize_stock_symbol,
    parse_markdown_action_rows,
)


def test_parser_extracts_stock_action_rows() -> None:
    response = """
| Exchange Symbol | Stock Symbol | Stock Name | Action (Buy/Add/Sell All/Trim/Hold/Buy New) | Current Units |
|---|---|---|---|---:|
| NSE | SUZLON | Suzlon Energy | Trim | 243 |
| NSE | INFY | Infosys | Hold | 10 |
"""
    rows = parse_markdown_action_rows(response)
    assert len(rows) == 2
    assert rows[0]["stock symbol"] == "SUZLON"
    assert normalize_action(rows[0]["action buy add sell all trim hold buy new"]) == "Trim"


def test_symbol_and_cursor_are_stable() -> None:
    assert normalize_stock_symbol("NSE:SUZLON.NS") == "SUZLON"
    covered_at = datetime(2026, 8, 6, 9, 56, tzinfo=timezone.utc)
    assert decode_history_cursor(encode_history_cursor(covered_at, 42)) == (covered_at, 42)


def test_backfill_marker_is_versioned() -> None:
    from app.domains.runs.final_actionable_history import (
        FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION,
        final_actionable_history_backfill_key,
    )

    assert FINAL_ACTIONABLE_HISTORY_BACKFILL_VERSION >= 2
    assert final_actionable_history_backfill_key(7).endswith(":7")
    assert "final_actionable_history_backfill:v" in final_actionable_history_backfill_key(7)
