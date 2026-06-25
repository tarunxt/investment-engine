import json
from datetime import date, datetime
import re
from time import monotonic

from celery.exceptions import MaxRetriesExceededError
import redis as _sync_redis

from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.sync_session import SyncSessionLocal
import app.infrastructure.database.all_models  # noqa: F401 — registers all ORM models with the mapper
from app.core.config import settings
from app.core.logging import WorkerLogHelper, get_logger
from app.domains.ai_providers.web_metadata import merge_web_metadata
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.models import Job
from app.domains.polymarket.event_preflight import (
    build_polymarket_event_prompt_and_metadata,
    finalize_polymarket_event_runtime_metadata,
)
from app.domains.runs.schemas import PolymarketEventRunContext
from app.infrastructure.messaging.task_registry import register_job_task_sync
from app.shared.types import JobStatus

logger = get_logger("app.domains.jobs.tasks")

_EVENT_REFERENCE_DATE_PATTERN = re.compile(r"\[EVENT_SNAPSHOT_DATE=([0-9]{4}-[0-9]{2}-[0-9]{2})\]")
_EVENT_EXACT_DATE_PATTERN = re.compile(r"\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\b")
_STOCK_TARGET_ROW_COUNT = 5
_MAX_STOCK_REPAIR_ATTEMPTS = 2
_INSUFFICIENT_RECOMMENDATIONS_MARKER = "insufficient recommendations"


def _to_markdown_table_from_stocks(stocks: list[dict]) -> str:
    """Build a sheet-safe markdown table from normalized stock rows."""
    if not stocks:
        return ""
    rebalance_key_order = [
        "exchange_symbol",
        "stock_symbol",
        "current_units",
        "action",
        "units_change",
        "final_units",
        "technical_setup",
        "entry_range",
        "stop_loss",
        "target",
        "analyst_source",
        "units_to_buy",
        "price_per_unit",
        "total_buy_amount",
        "upside_horizon",
        "weeks",
        "confidence_score",
        "rationale_remarks",
        "score_rationale_cruxx",
        "rationale_technical_short_term",
        "score_rationale_technical_short_term",
        "rationale_technical_medium_term",
        "score_rationale_technical_medium_term",
        "rationale_technical_long_term",
        "score_rationale_technical_long_term",
        "rationale_fundamentals_short_term",
        "score_rationale_fundamentals_short_term",
        "rationale_fundamentals_medium_long_term",
        "score_rationale_fundamentals_medium_long_term",
    ]
    key_order = rebalance_key_order if any(str(row.get("action", "")).strip() for row in stocks) else [
        "llm_name_model",
        "exchange_symbol",
        "stock_symbol",
        "stock_name",
        "technical_setup",
        "entry_range",
        "stop_loss",
        "target",
        "analyst_source",
        "units_to_buy",
        "price_per_unit",
        "total_buy_amount",
        "upside_horizon",
        "weeks",
        "confidence_score",
        "rationale_remarks",
        "rationale_technical_medium_term",
        "score_rationale_technical_medium_term",
        "rationale_technical_long_term",
        "score_rationale_technical_long_term",
        "rationale_fundamentals_short_term",
        "score_rationale_fundamentals_short_term",
        "rationale_fundamentals_medium_long_term",
        "score_rationale_fundamentals_medium_long_term",
        "rationale_technical_short_term",
        "score_rationale_technical_short_term",
        "run_number",
        "run_date",
        "run_time",
    ]
    is_rebalance_table = any(str(row.get("action", "")).strip() for row in stocks)
    headers = key_order if is_rebalance_table else [k for k in key_order if any(str(row.get(k, "")).strip() for row in stocks)]
    if not headers:
        return ""

    def _label(key: str) -> str:
        stock_labels = {
            "llm_name_model": "LLM Name + Model",
            "upside_horizon": "Upside Horizon (%)",
            "confidence_score": "Confidence Score (0-100)",
            "rationale_remarks": "Rationale Cruxx",
            "score_rationale_cruxx": "Score Rationale Cruxx",
            "rationale_technical_medium_term": "Rationale - Technical Setup (Medium Term)",
            "score_rationale_technical_medium_term": "Score Rationale - Technical Setup (Medium Term)",
            "rationale_technical_long_term": "Rationale - Technical Setup (Long Term)",
            "score_rationale_technical_long_term": "Score Rationale - Technical Setup (Long Term)",
            "rationale_fundamentals_short_term": "Rationale - Fundamentals Short Term",
            "score_rationale_fundamentals_short_term": "Score Rationale - Fundamentals Short Term",
            "rationale_fundamentals_medium_long_term": "Rationale - Fundamentals Medium/Long Term",
            "score_rationale_fundamentals_medium_long_term": "Score Rationale - Fundamentals Medium/Long Term",
            "rationale_technical_short_term": "Rationale Technical Setup Short Term 1–3 Months",
            "score_rationale_technical_short_term": "Score Rationale Technical Setup Short Term 1–3 Months",
            "run_number": "Run #",
            "run_date": "Run Date",
            "run_time": "Run Time",
        }
        rebalance_labels = {
            **stock_labels,
            "upside_horizon": "Upside Horizon (% return)",
            "current_units": "Current Units",
            "action": "Action (Buy/Add/Sell All/Trim/Hold/Buy New)",
            "units_change": "Units Change",
            "final_units": "Final Units",
            "analyst_source": "Analyst/Source",
            "price_per_unit": "Price Per Unit",
            "rationale_technical_short_term": "Rationale Technical Setup Short Term 1–3 Months",
            "score_rationale_technical_short_term": "Score Rationale Technical Setup Short Term 1–3 Months",
            "rationale_technical_medium_term": "Rationale - Technical Setup (Medium Term)",
            "score_rationale_technical_medium_term": "Score Rationale - Technical Setup (Medium Term)",
            "rationale_technical_long_term": "Rationale - Technical Setup (Long Term)",
            "score_rationale_technical_long_term": "Score Rationale - Technical Setup (Long Term)",
            "rationale_fundamentals_short_term": "Rationale - Fundamentals Short Term",
            "score_rationale_fundamentals_short_term": "Score Rationale - Fundamentals Short Term",
            "score_rationale_fundamentals_medium_long_term": "Score Rationale - Fundamentals Medium/Long Term",
        }
        labels = rebalance_labels if is_rebalance_table else stock_labels
        return labels.get(key, key.replace("_", " ").title())

    def _cell(value: object) -> str:
        return str(value if value is not None else "").replace("\n", " ").replace("|", "/").strip()

    lines = [
        f"| {' | '.join(_label(h) for h in headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]
    for row in stocks:
        lines.append(f"| {' | '.join(_cell(row.get(h, '')) for h in headers)} |")
    return "\n".join(lines)


def _repair_stock_table_content(content: str) -> tuple[str, int]:
    """Try to salvage malformed LLM output into valid markdown stock table."""
    from app.domains.google_sheets.stock_service import normalize_stock_rows, parse_stock_recommendations

    parsed_stocks = normalize_stock_rows(parse_stock_recommendations(content))
    if not parsed_stocks:
        return content, 0
    repaired = _to_markdown_table_from_stocks(parsed_stocks)
    return (repaired or content), len(parsed_stocks)


def _count_markdown_table_data_rows(content: str) -> int:
    """Count probable markdown table data rows (excluding header + separator)."""
    lines = [line.strip() for line in (content or "").splitlines() if line.strip()]
    pipe_lines = [line for line in lines if line.count("|") >= 2]
    if not pipe_lines:
        return 0

    def _is_separator(line: str) -> bool:
        normalized = line.replace("|", "").replace(":", "").replace("-", "").replace(" ", "")
        return normalized == ""

    data_rows = 0
    for idx, line in enumerate(pipe_lines):
        if idx == 0:
            continue  # header row
        if _is_separator(line):
            continue
        # Skip repeated header-like rows
        lower = line.lower()
        if "stock symbol" in lower and "technical setup" in lower:
            continue
        data_rows += 1
    return data_rows


def _requires_generic_table_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    return "return only one markdown table" in text or _requires_stock_recommendation_output(prompt)


def _is_rebalance_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    return "[rebalance_flow:" in text or "recommended rebalance" in text


def _requires_stock_recommendation_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    if _is_rebalance_output(prompt):
        return False
    return "table columns:" in text or ("stock name" in text and "units to buy" in text)


def _has_excessive_placeholder_noise(content: str) -> bool:
    text = content or ""
    dash_runs = re.findall(r"-{40,}", text)
    return len(dash_runs) >= 3


def _parse_normalized_stock_rows(content: str) -> list[dict]:
    from app.domains.google_sheets.stock_service import normalize_stock_rows, parse_stock_recommendations

    return normalize_stock_rows(parse_stock_recommendations(content))


def _parse_complete_stock_rows(content: str) -> list[dict]:
    from app.domains.google_sheets.stock_service import parse_complete_stock_recommendations

    return parse_complete_stock_recommendations(content)


def _merge_unique_stock_rows(existing_rows: list[dict], new_rows: list[dict]) -> list[dict]:
    merged_rows: list[dict] = []
    seen_symbols: set[str] = set()

    for row in [*existing_rows, *new_rows]:
        symbol = str(row.get("stock_symbol", "")).strip().upper()
        if not symbol or symbol in seen_symbols:
            continue
        merged_rows.append(row)
        seen_symbols.add(symbol)
        if len(merged_rows) >= _STOCK_TARGET_ROW_COUNT:
            break

    return merged_rows


def _is_insufficient_stock_issue(issue: str | None) -> bool:
    return bool(issue and _INSUFFICIENT_RECOMMENDATIONS_MARKER in issue)


def _failed_job_has_exportable_partial_stock_rows(job: Job) -> bool:
    if job.status not in {JobStatus.FAILED, JobStatus.PARTIAL}:
        return False
    if _INSUFFICIENT_RECOMMENDATIONS_MARKER not in (job.error_message or "").lower():
        return False
    if not job.response:
        return False
    try:
        return len(_parse_complete_stock_rows(job.response)) > 0
    except Exception:
        logger.warning("Partial stock exportability check skipped for job_id=%s", getattr(job, "id", "n/a"), exc_info=True)
        return False


def _validate_stock_table_content(content: str) -> tuple[str, str | None, list[dict]]:
    """Validate stock recommendation output and return normalized markdown when possible."""
    normalized_content = (content or "").strip()
    data_rows = _count_markdown_table_data_rows(normalized_content)

    if data_rows < 1:
        repaired_content, repaired_rows = _repair_stock_table_content(normalized_content)
        if repaired_rows > 0:
            normalized_content = repaired_content.strip()
            data_rows = _count_markdown_table_data_rows(normalized_content)
        if data_rows < 1:
            return normalized_content, "malformed table output (no data rows)", []

    try:
        parsed_stocks = _parse_normalized_stock_rows(normalized_content)
    except Exception:
        # Keep primary output validation resilient even if parser has issues.
        logger.warning("Stock parser validation skipped", exc_info=True)
        return normalized_content, None, []

    canonical_rows = parsed_stocks[:_STOCK_TARGET_ROW_COUNT]
    if canonical_rows:
        repaired_content = _to_markdown_table_from_stocks(canonical_rows)
        if repaired_content:
            normalized_content = repaired_content.strip()

    if len(parsed_stocks) >= _STOCK_TARGET_ROW_COUNT:
        return normalized_content, None, canonical_rows

    if _has_excessive_placeholder_noise(normalized_content):
        return normalized_content, "malformed table output (placeholder noise)", canonical_rows

    return (
        normalized_content,
        f"insufficient recommendations (expected {_STOCK_TARGET_ROW_COUNT}, got {len(parsed_stocks)})",
        canonical_rows,
    )



def _split_markdown_table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _extract_rebalance_current_holdings_from_prompt(prompt: str) -> list[dict[str, str]]:
    """Extract current portfolio holdings from the rebalance prompt input table."""
    text = prompt or ""
    section_match = re.search(
        r"##\s*1\.\s*Latest Portfolio Snapshot(?P<section>.*?)(?:\n##\s*2\.|\Z)",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not section_match:
        return []

    section = section_match.group("section")
    table_lines = [line.strip() for line in section.splitlines() if line.strip().startswith("|")]
    if len(table_lines) < 3:
        return []

    header_idx = next(
        (
            idx
            for idx, line in enumerate(table_lines)
            if "stock symbol" in line.lower() and "current units" in line.lower()
        ),
        None,
    )
    if header_idx is None:
        return []

    headers = [_normalize_rebalance_prompt_header(cell) for cell in _split_markdown_table_row(table_lines[header_idx])]
    try:
        symbol_idx = headers.index("stock symbol")
        current_units_idx = headers.index("current units")
    except ValueError:
        return []
    exchange_idx = headers.index("exchange") if "exchange" in headers else None

    holdings: list[dict[str, str]] = []
    seen_symbols: set[str] = set()
    for line in table_lines[header_idx + 1 :]:
        if line.replace("|", "").replace(":", "").replace("-", "").strip() == "":
            continue
        cells = _split_markdown_table_row(line)
        if len(cells) <= max(symbol_idx, current_units_idx):
            continue
        symbol = cells[symbol_idx].strip().upper()
        if not symbol or symbol in {"STOCK SYMBOL", "SYMBOL"}:
            continue
        units = cells[current_units_idx].strip()
        exchange = cells[exchange_idx].strip() if exchange_idx is not None and exchange_idx < len(cells) else ""
        if symbol in seen_symbols:
            continue
        holdings.append({"exchange_symbol": exchange, "stock_symbol": symbol, "current_units": units})
        seen_symbols.add(symbol)

    return holdings


def _normalize_rebalance_prompt_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _rebalance_missing_current_holdings_issue(prompt: str, parsed_rows: list[dict]) -> str | None:
    required_holdings = _extract_rebalance_current_holdings_from_prompt(prompt)
    if not required_holdings:
        return None

    output_symbols = {str(row.get("stock_symbol", "")).strip().upper() for row in parsed_rows}
    missing = [holding for holding in required_holdings if holding["stock_symbol"] not in output_symbols]
    if not missing:
        return None

    missing_labels = ", ".join(
        f"{holding['exchange_symbol']}:{holding['stock_symbol']}" if holding.get("exchange_symbol") else holding["stock_symbol"]
        for holding in missing
    )
    return (
        "partial rebalance table "
        f"(missing {len(missing)} current portfolio holding row(s): {missing_labels}; "
        f"expected at least {len(required_holdings)} current-holding rows)"
    )


def _validate_rebalance_table_content(content: str, prompt: str = "") -> tuple[str, str | None, list[dict]]:
    """Validate rebalance output and return canonical markdown when possible."""
    normalized_content = (content or "").strip()
    data_rows = _count_markdown_table_data_rows(normalized_content)
    if data_rows < 1:
        return normalized_content, "malformed table output (no data rows)", []

    try:
        parsed_rows = _parse_complete_stock_rows(normalized_content)
    except Exception:
        logger.warning("Rebalance parser validation skipped", exc_info=True)
        return normalized_content, None, []

    if not parsed_rows:
        return normalized_content, "malformed table output (no complete rebalance rows)", []

    missing_holdings_issue = _rebalance_missing_current_holdings_issue(prompt, parsed_rows)
    if missing_holdings_issue:
        return normalized_content, missing_holdings_issue, parsed_rows

    repaired_content = _to_markdown_table_from_stocks(parsed_rows)
    if repaired_content:
        normalized_content = repaired_content.strip()

    return normalized_content, None, parsed_rows


def _build_rebalance_table_repair_prompt(prompt: str, previous_output: str, reason: str) -> str:
    return (
        f"{prompt}\n\n"
        "[REBALANCE_TABLE_REPAIR]\n"
        "The previous assistant output was invalid.\n"
        f"Issue: {reason}.\n"
        "Regenerate the FULL rebalance answer and return ONLY one markdown table with the exact rebalance columns from the original prompt.\n"
        "Requirements:\n"
        "- Include one complete decision row for EVERY current portfolio holding from the Latest Portfolio Snapshot; do not omit holdings and do not stop after a subset.\n"
        "- Consider every stock from the supplied swing-trade tables as a possible fresh Buy New candidate, and include Buy New rows for the candidates that are stronger than existing holdings after threats/opportunity-cost review.\n"
        "- Every row must include Exchange Symbol, Stock Symbol, Current Units, Action, Units Change, Final Units, price/risk fields, Upside Horizon (% return), Weeks, confidence, and all rationale columns.\n"
        "- Put the action label only in Action; put the signed numeric unit delta only in Units Change; never swap these two columns.\n"
        "- Current Units, Units Change, Final Units, Units to Buy, Price Per Unit, Total Buy Amount, Upside Horizon, Weeks, confidence, and rationale-score cells must be numeric-only.\n"
        "- Entry Range must contain only the trade entry price/range (for example 145-148), not the technical setup narrative.\n"
        "- Technical Setup must contain the setup narrative/label, not the entry price range.\n"
        "- Units Change must be numeric: negative for Sell All/Trim, positive for Buy/Add/Buy New, and 0 for Hold.\n"
        "- Final Units must equal Current Units + Units Change.\n"
        "- Do not output placeholder rows, separators only, notes, or prose before/after the table.\n"
        "- Keep numeric fields numeric-only.\n\n"
        "Previous invalid output:\n"
        f"{previous_output}"
    ).strip()


def _build_stock_table_repair_prompt(prompt: str, previous_output: str, reason: str) -> str:
    return (
        f"{prompt}\n\n"
        "[STOCK_TABLE_REPAIR]\n"
        "The previous assistant output was invalid.\n"
        f"Issue: {reason}.\n"
        "Regenerate the FULL answer and return ONLY one markdown table that follows the original title and exact column order.\n"
        "Requirements:\n"
        "- Include exactly 5 unique stock recommendation rows.\n"
        "- Every row must be complete with all columns populated.\n"
        "- Do not output placeholder rows, separators, notes, or any prose before/after the table.\n"
        "- Keep numeric fields numeric-only and ensure the total allocation stays close to INR 50,000.\n"
        "- If some earlier rows were valid, you may reuse them, but the final table must be complete and self-contained.\n\n"
        "Previous invalid output:\n"
        f"{previous_output}"
    ).strip()


def _build_stock_table_top_up_prompt(
    prompt: str,
    existing_rows: list[dict],
    missing_count: int,
) -> str:
    existing_symbols = ", ".join(
        str(row.get("stock_symbol", "")).strip().upper()
        for row in existing_rows
        if str(row.get("stock_symbol", "")).strip()
    )
    existing_table = _to_markdown_table_from_stocks(existing_rows) or ""
    return (
        f"{prompt}\n\n"
        "[STOCK_TABLE_TOP_UP]\n"
        f"You already have {len(existing_rows)} valid stock rows. "
        f"Return ONLY one markdown table with exactly {missing_count} ADDITIONAL unique stock row"
        f"{'s' if missing_count != 1 else ''}.\n"
        "Requirements:\n"
        "- Use the exact same columns and column order as the original prompt.\n"
        "- Every cell in every returned row must be populated.\n"
        "- Do not repeat any existing stock symbol.\n"
        "- Do not include commentary, notes, or prose before or after the table.\n"
        "- Keep numeric fields numeric-only.\n"
        f"- Forbidden existing stock symbols: {existing_symbols or 'none'}.\n\n"
        "Existing locked rows:\n"
        f"{existing_table}"
    ).strip()


def _is_portfolio_events_job(prompt: str) -> bool:
    text = prompt or ""
    return "[INDMONEY_US_EVENTS]" in text or "[ZERODHA_EVENTS]" in text


def _extract_portfolio_event_reference_date(prompt: str) -> date | None:
    match = _EVENT_REFERENCE_DATE_PATTERN.search(prompt or "")
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        return None


def _is_portfolio_event_fallback_row(row: dict[str, str]) -> bool:
    row_date = (row.get("Date") or "").strip().lower()
    row_stock_name = (row.get("Stock Name") or row.get("Holding") or "").strip().lower()
    row_stock_symbol = (row.get("Stock Symbol") or "").strip().lower()
    row_event = (row.get("Event") or "").strip().lower()
    return (
        row_date == "not found"
        or row_stock_name == "all holdings"
        or row_stock_symbol == "all holdings"
        or "no upcoming scheduled price-sensitive event found" in row_event
    )


def _extract_first_exact_event_date(value: str) -> date | None:
    match = _EVENT_EXACT_DATE_PATTERN.search(value or "")
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%d %b %Y").date()
    except ValueError:
        return None


def _render_portfolio_event_table(rows: list[dict[str, str]]) -> str:
    from app.domains.portfolio_events.common import EVENT_TABLE_COLUMNS

    lines = [
        f"| {' | '.join(EVENT_TABLE_COLUMNS)} |",
        f"| {' | '.join('----' for _ in EVENT_TABLE_COLUMNS)} |",
    ]
    for row in rows:
        cells = [str((row.get(column) or "")).replace("\n", " ").replace("|", "/").strip() for column in EVENT_TABLE_COLUMNS]
        lines.append(f"| {' | '.join(cells)} |")
    return "\n".join(lines)


def _sanitize_portfolio_event_content(prompt: str, content: str) -> str:
    if not _is_portfolio_events_job(prompt):
        return (content or "").strip()

    from app.domains.portfolio_events.common import parse_event_calendar_table

    parsed = parse_event_calendar_table(content)
    rows = list((parsed or {}).get("rows") or [])
    if not rows:
        return (content or "").strip()

    reference_date = _extract_portfolio_event_reference_date(prompt)
    sanitized_rows: list[dict[str, str]] = []
    for row in rows:
        if _is_portfolio_event_fallback_row(row):
            continue
        event_date = _extract_first_exact_event_date(row.get("Date") or "")
        if reference_date and event_date and event_date < reference_date:
            continue
        sanitized_rows.append(row)

    if sanitized_rows:
        return _render_portfolio_event_table(sanitized_rows)

    return (content or "").strip()


def _portfolio_event_retry_reason(prompt: str, content: str) -> str | None:
    if not _is_portfolio_events_job(prompt):
        return None

    from app.domains.portfolio_events.common import parse_event_calendar_table

    parsed = parse_event_calendar_table(content)
    rows = list((parsed or {}).get("rows") or [])
    if not rows:
        return "it did not return any event rows"

    reference_date = _extract_portfolio_event_reference_date(prompt)
    upcoming_rows = 0
    past_rows = 0
    fallback_rows = 0

    for row in rows:
        if _is_portfolio_event_fallback_row(row):
            fallback_rows += 1
            continue
        event_date = _extract_first_exact_event_date(row.get("Date") or "")
        if reference_date and event_date and event_date < reference_date:
            past_rows += 1
            continue
        upcoming_rows += 1

    if upcoming_rows > 0:
        return None
    if past_rows > 0 and fallback_rows > 0:
        return "it mixed only past-dated event rows with the fallback `Not found` row"
    if past_rows > 0:
        return "it returned only past-dated events that are earlier than the reference date"
    if fallback_rows == len(rows):
        return "it used the fallback `Not found` row without listing any upcoming events"
    return None


def _build_portfolio_event_repair_prompt(prompt: str, previous_output: str, reason: str) -> str:
    reference_date = _extract_portfolio_event_reference_date(prompt)
    reference_text = (
        f"on or after {reference_date.isoformat()}"
        if reference_date
        else "that are still upcoming"
    )
    return (
        f"{prompt}\n\n"
        "[PORTFOLIO_EVENTS_REPAIR]\n"
        f"The previous assistant output was invalid because {reason}. "
        f"Re-check live web sources and return ONLY events {reference_text}. "
        "Remove any past-dated rows. "
        "If you find one or more upcoming events, do not include the `Not found` / `All holdings` fallback row. "
        "Use the exchange + stock symbol pair as authoritative when available, search exact scheduled dates, and sort rows nearest to farthest. "
        "Only use the fallback row if there are truly zero upcoming events after checking earnings/results, dividend/ex-date, AGM/shareholder meeting, and investor conference / product event sources.\n\n"
        "Previous assistant output:\n"
        f"{previous_output}"
    ).strip()


def _publish_job_update(job: Job) -> None:
    """Publish job status change to Redis pub/sub for WebSocket relay. Fire-and-forget."""
    r: _sync_redis.Redis | None = None
    try:
        status_val = job.status.value if hasattr(job.status, "value") else str(job.status)
        payload = json.dumps({
            "type": "job.updated",
            "job_id": job.id,
            "provider": job.provider,
            "model": job.model,
            "status": status_val,
            "response": job.response,
            "error_message": job.error_message,
            "tokens_in": job.tokens_in,
            "tokens_out": job.tokens_out,
            "estimated_cost": job.estimated_cost,
            "web_search_used": job.web_search_used,
            "web_search_queries": job.web_search_queries,
            "web_sources": job.web_sources,
            "runtime_metadata_json": job.runtime_metadata_json,
            "export_status": job.export_status,
            "export_error": job.export_error,
            "exported_at": job.exported_at.isoformat() if job.exported_at else None,
            "exported_sheet_url": job.exported_sheet_url,
            "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        })
        
        redis_url = settings.redis_url
        logger.info("Publishing WS update for job_id=%s to Redis at %s", job.id, redis_url)
        
        r = _sync_redis.from_url(redis_url, decode_responses=True)
        
        # Publish to job-specific channel
        job_channel = f"job_updates:{job.id}"
        job_receivers = r.publish(job_channel, payload)
        logger.info("Published to %s: %s receiver(s)", job_channel, job_receivers)
        
        # Publish to user channel if user_id exists
        if job.user_id:
            user_channel = f"user_job_updates:{job.user_id}"
            user_receivers = r.publish(user_channel, payload)
            logger.info("Published to %s: %s receiver(s)", user_channel, user_receivers)
        else:
            logger.warning("job.user_id is None, skipping user_job_updates publish for job_id=%s", job.id)
            
    except Exception as e:
        logger.exception("Failed to publish WS update for job_id=%s: %s", job.id, e)
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass

# ── Error classification ──────────────────────────────────────────────────────

def _classify_exc(exc: Exception, attempt: int = 0) -> tuple[bool, int]:
    """Return (retryable, countdown_seconds).

    Rate-limit errors use exponential backoff (60 / 120 / 240 s).
    Terminal client errors (bad request, auth) are not retried.
    Everything else retries after 30 s.
    """

    text = str(exc).lower()
    if any(
        marker in text
        for marker in (
            "returned malformed table output",
            "returned insufficient recommendations",
            "returned empty output after generation",
        )
    ):
        return False, 0

    if attempt >= 3:
        return False, 0  # don't retry after max attempts

    try:
        from google.genai.errors import ClientError as GeminiClientError
        if isinstance(exc, GeminiClientError):
            code = getattr(exc, "status_code", None)
            if code == 429:
                return True, 60 * (2 ** attempt)   # 60 → 120 → 240 s
            if code in (400, 401, 403):
                return False, 0                     # bad request / auth — terminal
            return True, 30
    except ImportError:
        pass

    try:
        from openai import (
            AuthenticationError as OpenAIAuthenticationError,
            BadRequestError as OpenAIBadRequest,
            NotFoundError as OpenAINotFoundError,
            PermissionDeniedError as OpenAIPermissionDeniedError,
            RateLimitError as OpenAIRateLimit,
        )
        if isinstance(exc, OpenAIRateLimit):
            if getattr(exc, "code", None) == "insufficient_quota" or "insufficient_quota" in str(exc):
                return False, 0
            return True, 60 * (2 ** attempt)
        if isinstance(
            exc,
            (
                OpenAIAuthenticationError,
                OpenAIBadRequest,
                OpenAINotFoundError,
                OpenAIPermissionDeniedError,
            ),
        ):
            return False, 0
    except ImportError:
        pass

    return True, 30  # default: retryable


def _redis_publish(channel: str, payload: dict) -> None:
    """Publish a single message to a Redis pub/sub channel. Fire-and-forget."""
    r: _sync_redis.Redis | None = None
    try:
        r = _sync_redis.from_url(settings.redis_url, decode_responses=True)
        r.publish(channel, json.dumps(payload))
    except Exception:
        logger.exception("Failed to publish to channel %s", channel)
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass


def _publish_run_update(
    run_id: int,
    user_id: int | None,
    status: JobStatus,
    current_stage: int,
    export_status: str | None = None,
    export_error: str | None = None,
    exported_at: str | None = None,
    exported_sheet_url: str | None = None,
) -> None:
    """Broadcast a run status change to the user-level and per-run Redis channels."""
    status_val = status.value if hasattr(status, "value") else str(status)
    payload = {
        "type": "run.updated",
        "run_id": run_id,
        "status": status_val,
        "current_stage": current_stage,
        "export_status": export_status,
        "export_error": export_error,
        "exported_at": exported_at,
        "exported_sheet_url": exported_sheet_url,
    }
    # Per-run channel — consumed by the run detail page
    _redis_publish(f"run_updates:{run_id}", payload)
    # User-level channel — consumed by the dashboard list
    if user_id:
        _redis_publish(f"user_run_updates:{user_id}", payload)


def _queue_run_completion_email_once(run_id: int, status: JobStatus) -> None:
    """Queue a single completion email for this run/status using Redis SETNX."""
    if status not in {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}:
        return

    dedupe_key = f"run_completion_email_sent:{run_id}:{status.value}"
    redis_client: _sync_redis.Redis | None = None
    try:
        redis_client = _sync_redis.from_url(settings.redis_url, decode_responses=True)
        if not redis_client.set(dedupe_key, "1", nx=True, ex=60 * 60 * 24 * 30):
            return
        from app.domains.runs.tasks import send_run_completion_email_task

        send_run_completion_email_task.delay(run_id)  # type: ignore
        logger.info("Queued run completion email for run %s", run_id)
    except Exception:
        logger.exception("Failed to queue run completion email for run %s", run_id)
        if redis_client is not None:
            try:
                redis_client.delete(dedupe_key)
            except Exception:
                logger.exception(
                    "Failed to release run completion email dedupe key for run %s",
                    run_id,
                )
    finally:
        if redis_client is not None:
            try:
                redis_client.close()
            except Exception:
                pass


def _refresh_run_status(db, job_id: int) -> None:
    """Recalculate and persist Run.status when a child job reaches a terminal state."""
    try:
        from sqlalchemy import select as sa_select
        from app.domains.runs.models import RunJob
        from app.domains.runs.repository import SyncRunRepository

        run_repo = SyncRunRepository(db)

        rj_rows = db.execute(
            sa_select(RunJob).where(RunJob.job_id == job_id)
        ).scalars().all()

        for rj in rj_rows:
            run = run_repo.get(rj.run_id)
            if not run:
                continue
            run_id = run.id
            user_id = run.user_id
            current_stage = run.current_stage
            auto_export_enabled = run.auto_export_enabled
            export_spreadsheet_url = run.export_spreadsheet_url
            export_sheet_name = run.export_sheet_name
            export_investment_amount = run.export_investment_amount
            export_title = run.export_title

            pairs = run_repo.get_stage_run_jobs(rj.run_id, rj.stage)
            if not pairs:
                continue

            stage_jobs = [job for _, job in pairs]

            # Push the triggering job's full data to the per-run channel so the
            # detail page can update response text, tokens, and cost in real-time.
            updated_job = next((j for j in stage_jobs if j.id == job_id), None)
            if updated_job is not None:
                status_val = (
                    updated_job.status.value
                    if hasattr(updated_job.status, "value")
                    else str(updated_job.status)
                )
                _redis_publish(f"run_updates:{rj.run_id}", {
                    "type": "job.updated",
                    "run_id": rj.run_id,
                    "job_id": updated_job.id,
                    "provider": updated_job.provider,
                    "model": updated_job.model,
                    "status": status_val,
                    "response": updated_job.response,
                    "error_message": updated_job.error_message,
                    "tokens_in": updated_job.tokens_in,
                    "tokens_out": updated_job.tokens_out,
                    "estimated_cost": updated_job.estimated_cost,
                    "export_status": updated_job.export_status,
                    "export_error": updated_job.export_error,
                    "exported_at": updated_job.exported_at.isoformat() if updated_job.exported_at else None,
                    "exported_sheet_url": updated_job.exported_sheet_url,
                    "updated_at": updated_job.updated_at.isoformat() if updated_job.updated_at else None,
                })
                if updated_job.user_id:
                    _redis_publish(f"user_run_updates:{updated_job.user_id}", {
                        "type": "job.updated",
                        "run_id": rj.run_id,
                        "job_id": updated_job.id,
                        "provider": updated_job.provider,
                        "model": updated_job.model,
                        "status": status_val,
                        "response": updated_job.response,
                        "error_message": updated_job.error_message,
                        "tokens_in": updated_job.tokens_in,
                        "tokens_out": updated_job.tokens_out,
                        "estimated_cost": updated_job.estimated_cost,
                        "export_status": updated_job.export_status,
                        "export_error": updated_job.export_error,
                        "exported_at": updated_job.exported_at.isoformat() if updated_job.exported_at else None,
                        "exported_sheet_url": updated_job.exported_sheet_url,
                        "updated_at": updated_job.updated_at.isoformat() if updated_job.updated_at else None,
                    })

            statuses = {j.status for j in stage_jobs}
            active = {JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.SCHEDULED}

            if statuses & active:
                # At least one child job is still running
                new_status = JobStatus.PROCESSING
            elif any(j.status == JobStatus.COMPLETED for j in stage_jobs):
                # All terminal, at least one succeeded
                new_status = JobStatus.COMPLETED
            elif any(j.status == JobStatus.PARTIAL for j in stage_jobs):
                # All terminal and at least one usable-but-incomplete model output exists.
                new_status = JobStatus.PARTIAL
            else:
                # All terminal, all failed
                new_status = JobStatus.FAILED

            if run.status != new_status:
                run_repo.update_status(run, new_status)
                _publish_run_update(
                    run_id,
                    user_id,
                    new_status,
                    current_stage,
                    run.export_status,
                    run.export_error,
                    run.exported_at.isoformat() if run.exported_at else None,
                    run.exported_sheet_url,
                )
                logger.info("Run %s status → %s", run_id, new_status.value)
                _queue_run_completion_email_once(run_id, new_status)

            # Trigger auto-export per model as soon as a model completes, or when
            # a failed model still produced complete stock rows that can be exported.
            if (
                updated_job is not None
                and updated_job.status in {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}
                and auto_export_enabled
                and export_spreadsheet_url
                and (
                    updated_job.status in {JobStatus.COMPLETED, JobStatus.PARTIAL}
                    or _failed_job_has_exportable_partial_stock_rows(updated_job)
                )
                and (updated_job.export_status or "").lower() not in {"queued", "processing", "completed", "failed"}
            ):
                try:
                    from app.domains.google_sheets.tasks import export_job_to_sheets_task
                    repo = SyncJobRepository(db)
                    repo.update_export_state(
                        updated_job,
                        export_status="queued",
                        export_error=None,
                    )
                    _publish_job_update(updated_job)
                    _publish_run_update(
                        run_id,
                        user_id,
                        run.status,
                        current_stage,
                        run.export_status,
                        run.export_error,
                        run.exported_at.isoformat() if run.exported_at else None,
                        run.exported_sheet_url,
                    )
                    export_job_to_sheets_task.delay(  # type: ignore
                        user_id,
                        updated_job.id,
                        export_spreadsheet_url,
                        export_sheet_name or "Sheet1",
                        export_title or f"Run {run_id}",
                        export_investment_amount or "0",
                        run_id,
                        rj.stage,
                    )
                    logger.info("Queued model export for run %d job %d", run_id, updated_job.id)
                except Exception as e:
                    logger.warning(
                        "Failed to queue model export for run %d job %d: %s",
                        run_id,
                        updated_job.id,
                        str(e),
                    )
            elif (
                updated_job is not None
                and updated_job.status == JobStatus.FAILED
                and auto_export_enabled
                and (updated_job.export_status or "").lower() in {"", "pending"}
            ):
                repo = SyncJobRepository(db)
                repo.update_export_state(
                    updated_job,
                    export_status="failed",
                    export_error=updated_job.error_message or "Model failed before export",
                )
                _publish_job_update(updated_job)

            # Keep run-level export badge in sync with per-model export progress
            if auto_export_enabled:
                run_after = run_repo.get(rj.run_id)
                if run_after:
                    stage_pairs = run_repo.get_stage_run_jobs(rj.run_id, rj.stage)
                    stage_jobs_after = [job for _, job in stage_pairs]
                    terminal = {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}
                    eligible_jobs = [j for j in stage_jobs_after if j.status in terminal]
                    exports = [str((j.export_status or "pending")).lower() for j in eligible_jobs]
                    completed_count = sum(1 for s in exports if s == "completed")
                    failed_count = sum(1 for s in exports if s == "failed")
                    inflight_count = sum(1 for s in exports if s in {"pending", "queued", "processing", ""})
                    total_count = len(exports)

                    export_state = "pending"
                    export_error = None
                    if total_count == 0:
                        export_state = "pending"
                    elif completed_count == total_count:
                        export_state = "completed"
                    elif failed_count == total_count:
                        export_state = "failed"
                        failed = next(
                            (j for j in eligible_jobs if (j.export_status or "").lower() == "failed"),
                            None,
                        )
                        export_error = failed.export_error if failed else None
                    elif completed_count > 0 and (failed_count > 0 or inflight_count > 0):
                        export_state = "partial"
                        export_error = f"{completed_count}/{total_count} exported"
                    else:
                        export_state = "processing"
                        if failed_count > 0:
                            export_error = f"{completed_count}/{total_count} exported"

                    prev_export_status = (run_after.export_status or "").lower()
                    prev_export_error = run_after.export_error
                    run_repo.update_export_state(
                        run_after,
                        export_status=export_state,
                        export_error=export_error,
                        exported_at=run_after.exported_at,
                        exported_sheet_url=run_after.exported_sheet_url,
                    )
                    if prev_export_status != export_state or prev_export_error != export_error:
                        _publish_run_update(
                            run_after.id,
                            run_after.user_id,
                            run_after.status,
                            run_after.current_stage,
                            run_after.export_status,
                            run_after.export_error,
                            run_after.exported_at.isoformat() if run_after.exported_at else None,
                            run_after.exported_sheet_url,
                        )
    except Exception:
        logger.exception("Failed to refresh run status for job %s", job_id)


def _mark_failed(
    db,
    repo,
    job_id: int,
    error: str,
    *,
    response: str | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    estimated_cost: float | None = None,
    web_search_used: bool | None = None,
    web_search_queries: list[str] | None = None,
    web_sources: list[str] | None = None,
    runtime_metadata_json: dict | None = None,
) -> None:
    try:
        db.rollback()
        job = repo.get(job_id)
        if job:
            repo.update_status(
                job,
                JobStatus.FAILED,
                response=response,
                error_message=error,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                estimated_cost=estimated_cost,
                web_search_used=web_search_used,
                web_search_queries=web_search_queries,
                web_sources=web_sources,
                runtime_metadata_json=runtime_metadata_json,
            )
            _publish_job_update(job)
            _refresh_run_status(db, job_id)
    except Exception:
        logger.exception("Could not mark job %s as failed", job_id)


def _job_was_cancelled(repo: SyncJobRepository, job_id: int) -> bool:
    latest = repo.get(job_id)
    return bool(
        latest
        and latest.status == JobStatus.FAILED
        and "cancelled" in (latest.error_message or "").lower()
    )


# ── Task ─────────────────────────────────────────────────────────────────────

@celery.task(
    name="app.domains.jobs.tasks.execute_ai_job",
    bind=True,
    max_retries=3,
    default_retry_delay=30,
    queue="ai",
)
def execute_ai_job(self, job_id: int) -> None:
    from app.domains.ai_providers.factory import ProviderFactory

    db = SyncSessionLocal()
    repo = SyncJobRepository(db)
    started_at = monotonic()
    content: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    estimated_cost: float | None = None
    web_search_used: bool | None = None
    web_search_queries: list[str] | None = None
    web_sources: list[str] | None = None
    runtime_metadata_json: dict | None = None

    try:
        if self.request.id:
            register_job_task_sync(job_id, self.request.id)
        job = repo.get(job_id)
        if not job:
            logger.warning("Job %s not found", job_id)
            return
        if _job_was_cancelled(repo, job_id):
            logger.info("Skipping cancelled job %s", job_id)
            return

        WorkerLogHelper.log_task_start("execute_ai_job", "n/a", job_id)
        repo.update_status(job, JobStatus.PROCESSING)
        _publish_job_update(job)
        _refresh_run_status(db, job_id)

        prompt_to_execute = job.prompt
        polymarket_event_context: PolymarketEventRunContext | None = None
        if isinstance(job.request_context_json, dict):
            request_kind = str(job.request_context_json.get("kind") or "").strip()
            if request_kind == "polymarket_bullpen_event":
                polymarket_event_context = PolymarketEventRunContext.model_validate(
                    job.request_context_json
                )
                prompt_to_execute, runtime_metadata_json = (
                    build_polymarket_event_prompt_and_metadata(
                        polymarket_event_context,
                        provider_name=job.provider.strip().lower(),
                    )
                )
                web_search_used, web_search_queries, web_sources = merge_web_metadata(
                    web_search_used,
                    web_search_queries,
                    web_sources,
                    response_used=runtime_metadata_json.get("web_search_used"),
                    response_queries=runtime_metadata_json.get("web_search_queries"),
                    response_sources=runtime_metadata_json.get("web_sources"),
                )

        provider = ProviderFactory.create(job.provider)
        result = provider.generate(prompt=prompt_to_execute, model=job.model)
        tokens_in = result.tokens_in
        tokens_out = result.tokens_out
        estimated_cost = result.cost
        web_search_used, web_search_queries, web_sources = merge_web_metadata(
            web_search_used,
            web_search_queries,
            web_sources,
            response_used=result.web_search_used,
            response_queries=result.web_search_queries,
            response_sources=result.web_sources,
        )
        content = (result.content or "").strip()
        if not content:
            raise RuntimeError(
                f"{job.provider}/{job.model} returned empty output after generation"
            )
        if _requires_generic_table_output(job.prompt):
            if _is_rebalance_output(job.prompt):
                content, rebalance_table_issue, _parsed_rebalance_rows = _validate_rebalance_table_content(content, job.prompt)
                for attempt in range(_MAX_STOCK_REPAIR_ATTEMPTS):
                    if not rebalance_table_issue:
                        break
                    if _job_was_cancelled(repo, job_id):
                        logger.info("Stopping cancelled rebalance repair job %s", job_id)
                        return
                    logger.info(
                        "Repairing rebalance table for job %s because %s (attempt %s/%s)",
                        job_id,
                        rebalance_table_issue,
                        attempt + 1,
                        _MAX_STOCK_REPAIR_ATTEMPTS,
                    )
                    repair_result = provider.generate(
                        prompt=_build_rebalance_table_repair_prompt(
                            job.prompt,
                            content,
                            rebalance_table_issue,
                        ),
                        model=job.model,
                    )
                    tokens_in = (tokens_in or 0) + repair_result.tokens_in
                    tokens_out = (tokens_out or 0) + repair_result.tokens_out
                    estimated_cost = round((estimated_cost or 0.0) + repair_result.cost, 6)
                    web_search_used, web_search_queries, web_sources = merge_web_metadata(
                        web_search_used,
                        web_search_queries,
                        web_sources,
                        response_used=repair_result.web_search_used,
                        response_queries=repair_result.web_search_queries,
                        response_sources=repair_result.web_sources,
                    )
                    repaired_content = (repair_result.content or "").strip()
                    if repaired_content:
                        content = repaired_content
                    content, rebalance_table_issue, _parsed_rebalance_rows = _validate_rebalance_table_content(content, job.prompt)
                if rebalance_table_issue:
                    has_any_rebalance_rows = _count_markdown_table_data_rows(content) > 0
                    should_keep_partial_rebalance = (
                        (rebalance_table_issue.startswith("partial rebalance table") and _parsed_rebalance_rows)
                        or (
                            rebalance_table_issue.startswith("malformed table output")
                            and has_any_rebalance_rows
                        )
                    )
                    if should_keep_partial_rebalance:
                        repo.update_status(
                            job,
                            JobStatus.PARTIAL,
                            response=content,
                            error_message=f"{job.provider}/{job.model} returned {rebalance_table_issue}",
                            tokens_in=tokens_in,
                            tokens_out=tokens_out,
                            estimated_cost=estimated_cost,
                            web_search_used=web_search_used,
                            web_search_queries=web_search_queries,
                            web_sources=web_sources,
                        )
                        _publish_job_update(job)
                        _refresh_run_status(db, job_id)
                        WorkerLogHelper.log_task_complete(
                            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
                        )
                        return
                    raise RuntimeError(
                        f"{job.provider}/{job.model} returned {rebalance_table_issue}"
                    )
            elif _requires_stock_recommendation_output(job.prompt):
                content, stock_table_issue, parsed_stocks = _validate_stock_table_content(content)
                for attempt in range(_MAX_STOCK_REPAIR_ATTEMPTS):
                    if not stock_table_issue:
                        break
                    if _job_was_cancelled(repo, job_id):
                        logger.info("Stopping cancelled stock repair job %s", job_id)
                        return
                    logger.info(
                        "Repairing stock table for job %s because %s (attempt %s/%s)",
                        job_id,
                        stock_table_issue,
                        attempt + 1,
                        _MAX_STOCK_REPAIR_ATTEMPTS,
                    )
                    missing_count = max(1, _STOCK_TARGET_ROW_COUNT - len(parsed_stocks))
                    use_top_up_prompt = _is_insufficient_stock_issue(stock_table_issue) and bool(parsed_stocks)
                    repair_prompt = (
                        _build_stock_table_top_up_prompt(
                            job.prompt,
                            parsed_stocks,
                            missing_count,
                        )
                        if use_top_up_prompt
                        else _build_stock_table_repair_prompt(
                            job.prompt,
                            content,
                            stock_table_issue,
                        )
                    )
                    repair_result = provider.generate(
                        prompt=repair_prompt,
                        model=job.model,
                    )
                    tokens_in = (tokens_in or 0) + repair_result.tokens_in
                    tokens_out = (tokens_out or 0) + repair_result.tokens_out
                    estimated_cost = round((estimated_cost or 0.0) + repair_result.cost, 6)
                    web_search_used, web_search_queries, web_sources = merge_web_metadata(
                        web_search_used,
                        web_search_queries,
                        web_sources,
                        response_used=repair_result.web_search_used,
                        response_queries=repair_result.web_search_queries,
                        response_sources=repair_result.web_sources,
                    )
                    repaired_content = (repair_result.content or "").strip()
                    if repaired_content:
                        if use_top_up_prompt:
                            supplemental_rows = _parse_normalized_stock_rows(repaired_content)
                            merged_rows = _merge_unique_stock_rows(parsed_stocks, supplemental_rows)
                            merged_content = _to_markdown_table_from_stocks(merged_rows)
                            content = (merged_content or repaired_content).strip()
                        else:
                            content = repaired_content
                    content, stock_table_issue, parsed_stocks = _validate_stock_table_content(content)
                if stock_table_issue:
                    if _is_insufficient_stock_issue(stock_table_issue) and parsed_stocks:
                        repo.update_status(
                            job,
                            JobStatus.PARTIAL,
                            response=content,
                            error_message=f"{job.provider}/{job.model} returned {stock_table_issue}",
                            tokens_in=tokens_in,
                            tokens_out=tokens_out,
                            estimated_cost=estimated_cost,
                            web_search_used=web_search_used,
                            web_search_queries=web_search_queries,
                            web_sources=web_sources,
                        )
                        _publish_job_update(job)
                        _refresh_run_status(db, job_id)
                        WorkerLogHelper.log_task_complete(
                            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
                        )
                        return
                    raise RuntimeError(
                        f"{job.provider}/{job.model} returned {stock_table_issue}"
                    )
            elif _count_markdown_table_data_rows(content) < 1:
                raise RuntimeError(
                    f"{job.provider}/{job.model} returned malformed table output (no data rows)"
                )
        if _is_portfolio_events_job(job.prompt):
            content = _sanitize_portfolio_event_content(job.prompt, content)
            retry_reason = _portfolio_event_retry_reason(job.prompt, content)
            if retry_reason:
                if _job_was_cancelled(repo, job_id):
                    logger.info("Stopping cancelled portfolio events job %s", job_id)
                    return
                logger.info("Retrying portfolio events job %s because %s", job_id, retry_reason)
                repair_result = provider.generate(
                    prompt=_build_portfolio_event_repair_prompt(job.prompt, content, retry_reason),
                    model=job.model,
                )
                tokens_in = (tokens_in or 0) + repair_result.tokens_in
                tokens_out = (tokens_out or 0) + repair_result.tokens_out
                estimated_cost = round((estimated_cost or 0.0) + repair_result.cost, 6)
                web_search_used, web_search_queries, web_sources = merge_web_metadata(
                    web_search_used,
                    web_search_queries,
                    web_sources,
                    response_used=repair_result.web_search_used,
                    response_queries=repair_result.web_search_queries,
                    response_sources=repair_result.web_sources,
                )
                repaired_content = (repair_result.content or "").strip()
                if repaired_content:
                    content = _sanitize_portfolio_event_content(job.prompt, repaired_content)
        if polymarket_event_context is not None and runtime_metadata_json is not None:
            runtime_metadata_json = finalize_polymarket_event_runtime_metadata(
                polymarket_event_context,
                provider_name=job.provider.strip().lower(),
                content=content,
                model_web_search_used=bool(result.web_search_used),
                model_web_search_queries=result.web_search_queries,
                model_web_sources=result.web_sources,
                runtime_metadata=runtime_metadata_json,
            )
        if _job_was_cancelled(repo, job_id):
            logger.info("Skipping completion update for cancelled job %s", job_id)
            return

        repo.update_status(
            job,
            JobStatus.COMPLETED,
            response=content,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            estimated_cost=estimated_cost,
            web_search_used=web_search_used,
            web_search_queries=web_search_queries,
            web_sources=web_sources,
            runtime_metadata_json=runtime_metadata_json,
        )
        _publish_job_update(job)
        _refresh_run_status(db, job_id)
        WorkerLogHelper.log_task_complete(
            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
        )

    except MaxRetriesExceededError:
        _mark_failed(
            db,
            repo,
            job_id,
            "Max retries exceeded",
            response=content,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            estimated_cost=estimated_cost,
            web_search_used=web_search_used,
            web_search_queries=web_search_queries,
            web_sources=web_sources,
            runtime_metadata_json=runtime_metadata_json,
        )
        logger.error("Job %s exhausted all retries", job_id)

    except Exception as exc:
        error_summary = str(exc).split('\n')[0][:200]
        WorkerLogHelper.log_task_error("execute_ai_job", "n/a", error_summary, job_id)

        retryable, countdown = _classify_exc(exc, attempt=self.request.retries)
        logger.info("Error classified as retryable=%s with countdown=%s seconds", retryable, countdown)
        if not retryable:
            _mark_failed(
                db,
                repo,
                job_id,
                str(exc),
                response=content,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                estimated_cost=estimated_cost,
                web_search_used=web_search_used,
                web_search_queries=web_search_queries,
                web_sources=web_sources,
                runtime_metadata_json=runtime_metadata_json,
            )
            return

        try:
            raise self.retry(exc=exc, countdown=countdown, max_retries=self.max_retries)
        except MaxRetriesExceededError:
            _mark_failed(
                db,
                repo,
                job_id,
                str(exc),
                response=content,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                estimated_cost=estimated_cost,
                web_search_used=web_search_used,
                web_search_queries=web_search_queries,
                web_sources=web_sources,
                runtime_metadata_json=runtime_metadata_json,
            )
            logger.error("Job %s exhausted all retries after: %s", job_id, exc)

    finally:
        db.close()
