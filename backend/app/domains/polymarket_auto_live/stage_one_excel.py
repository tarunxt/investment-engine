from __future__ import annotations

import base64
import json
import zlib
import logging
import math
import os
import tempfile
import zipfile
from datetime import datetime
from html import escape
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Iterator
from zoneinfo import ZoneInfo

if TYPE_CHECKING:
    from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveRun


EXCEL_HEADERS = tuple(json.loads(Path(__file__).with_name("stage_one_excel_columns.json").read_text()))
BASE_COLUMN_COUNT = 31
EXCEL_MAX_DATA_ROWS = 1_048_575
EXCEL_MAX_CELL_CHARACTERS = 32_767


class StageOneExcelExportError(ValueError):
    pass


def encode_scan_export_data(raw: dict[str, Any]) -> str:
    events = raw.get("events")
    event = raw.get("_export_event") or (events[0] if isinstance(events, list) and events else {})
    event = {key: value for key, value in event.items() if key != "markets"} if isinstance(event, dict) else {}
    market = {key: value for key, value in raw.items() if key not in {"_export_event", "events"}}
    payload = json.dumps({"event": event, "market": market}, ensure_ascii=False, separators=(",", ":"))
    return base64.b64encode(zlib.compress(payload.encode("utf-8"))).decode("ascii")


def decode_scan_export_data(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("scan_export_data")
    if not value:
        return {"event": {}, "market": {}}
    if str(value).startswith("source-v1:"):
        from app.domains.polymarket_auto_live.scan_source_store import read_scan_source
        compressed = read_scan_source(value)
    else:
        compressed = base64.b64decode(value)
    return json.loads(zlib.decompress(compressed))


def _export_headers(rows: Iterable[dict[str, Any]]) -> tuple[str, ...]:
    extra = set()
    for row in rows:
        data = decode_scan_export_data(row)
        for prefix in ("event", "market"):
            extra.update(f"{prefix}.{key}" for key in data[prefix])
    return (*EXCEL_HEADERS, *sorted(extra.difference(EXCEL_HEADERS)), "export.source", "export.fetchedAt", "export.status")


def _scan_outputs(run: BullpenAutoLiveRun) -> dict[str, Any]:
    for stage in run.stage_results:
        if stage.outputs.get("workflow_stage_key") == "scan":
            return stage.outputs
    for stage in run.stage_results:
        if stage.stage_number == 1:
            return stage.outputs
    raise StageOneExcelExportError("This run does not contain Stage 1 scan output.")


def _candidate_rows(
    run: BullpenAutoLiveRun,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    outputs = _scan_outputs(run)
    accepted = outputs.get("accepted_candidates")
    rejected = outputs.get("rejected_candidates")
    accepted_rows = [row for row in accepted if isinstance(row, dict)] if isinstance(accepted, list) else []
    rejected_rows = [row for row in rejected if isinstance(row, dict)] if isinstance(rejected, list) else []
    detailed_count = len(accepted_rows) + len(rejected_rows)
    expected_raw = outputs.get("scanned_candidates", outputs.get("total_items"))
    expected = int(expected_raw) if isinstance(expected_raw, (int, float)) else detailed_count
    if expected != detailed_count:
        raise StageOneExcelExportError(
            f"The frozen run contains {detailed_count:,} detailed rows but reports {expected:,} scanned events. "
            "A complete Excel file cannot be produced from a truncated run snapshot."
        )
    if expected > EXCEL_MAX_DATA_ROWS:
        raise StageOneExcelExportError(
            f"This run contains {expected:,} rows, exceeding Excel's {EXCEL_MAX_DATA_ROWS:,}-row data limit."
        )
    return accepted_rows, rejected_rows, expected


def _iter_candidates(
    accepted: Iterable[dict[str, Any]],
    rejected: Iterable[dict[str, Any]],
) -> Iterator[tuple[dict[str, Any], str]]:
    yield from ((row, "passed") for row in accepted)
    yield from ((row, "filtered") for row in rejected)


def _format_ist(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            return value.strip()
        return parsed.astimezone(ZoneInfo("Asia/Kolkata")).strftime("%-d %b %Y, %-I:%M:%S %p")
    except (ValueError, OSError):
        return value.strip()


def _yes_no(value: Any) -> str:
    if value is None:
        return ""
    return "Yes" if bool(value) else "No"


@lru_cache(maxsize=16)
def _extra_keys(headers: tuple[str, ...]):
    return tuple(header.split(".", 1) for header in headers[BASE_COLUMN_COUNT:])


def _source_fallbacks(row: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    market, event = data["market"], data["event"]
    enriched = dict(row)
    # New scans externalize duplicate normalized text. Restore it one row at
    # a time before raw-field fallbacks; older source packs remain unchanged.
    stored_text = data.get("candidate_text_fields_v1")
    if isinstance(stored_text, dict):
        for key, value in stored_text.items():
            if enriched.get(key) is None or enriched.get(key) == "":
                enriched[key] = value
    mapping = {
        "question_id": market.get("questionID"), "condition_id": market.get("conditionId"),
        "volume_usd": market.get("volumeNum", market.get("volume")),
        "liquidity_usd": market.get("liquidityNum", market.get("liquidity")),
        "rules": market.get("resolutionCriteria") or market.get("description"),
        "event_description": event.get("description"),
        "resolution_source": market.get("resolutionSource") or event.get("resolutionSource"),
        "market_context": market.get("description"),
    }
    for normalized, raw in (("best_bid_cents", "bestBid"), ("best_ask_cents", "bestAsk"), ("spread_cents", "spread")):
        try:
            value = float(market[raw])
            mapping[normalized] = value * 100 if abs(value) <= 1 else value
        except (KeyError, TypeError, ValueError):
            pass
    for key, value in mapping.items():
        if enriched.get(key) is None or enriched.get(key) == "":
            enriched[key] = value
    return enriched


def _row_values(row: dict[str, Any], index: int, scan_status: str, headers: tuple[str, ...] = EXCEL_HEADERS) -> tuple[Any, ...]:
    reasons = row.get("reasons")
    filter_reasons = " | ".join(str(item) for item in reasons) if isinstance(reasons, list) else ""
    selected = row.get("selected")
    data = decode_scan_export_data(row)
    row = _source_fallbacks(row, data)
    data["export"] = row.get("export_metadata") or {
        "source": "Saved scan source", "fetchedAt": "N/A",
        "status": "N/A means source field unavailable, not applicable, or LLM/allocation not calculated.",
    }
    extra = tuple(data[prefix].get(key) for prefix, key in _extra_keys(headers))
    return (
        index, row.get("question_id", ""), row.get("market_id", ""),
        row.get("condition_id", ""), row.get("question") or row.get("market_title") or "",
        row.get("market_url", ""), row.get("slug", ""), _format_ist(row.get("close_time")),
        row.get("close_time", ""), row.get("theme", ""), row.get("current_yes_odds"),
        row.get("current_no_odds"), row.get("best_bid_cents"), row.get("best_ask_cents"),
        row.get("spread_cents"), row.get("llm_yes_odds"), row.get("llm_no_odds"),
        row.get("returns_per_day"), row.get("amount_to_be_invested"), row.get("volume_usd"),
        row.get("liquidity_usd"), _yes_no(row.get("force_include")),
        _yes_no(row.get("force_included_position")),
        "" if selected is None else _yes_no(selected), scan_status,
        filter_reasons, row.get("rules", ""), row.get("event_description", ""),
        row.get("market_context", ""), row.get("resolution_source", ""),
        row.get("preflight_evidence_block", ""),
    ) + extra


def _column_name(index: int) -> str:
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _cell_xml(reference: str, value: Any, *, style: int | None = None) -> str:
    if value is None or value == "" or value == "N/A":
        return f'<c r="{reference}" t="s"><v>0</v></c>'
    style_attr = f' s="{style}"' if style is not None else ""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return f'<c r="{reference}"{style_attr}><v>{value}</v></c>'
    text = "" if value is None else json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
    text = "".join(
        character
        for character in text
        if character in "\t\n\r" or ord(character) >= 32
    )[:EXCEL_MAX_CELL_CHARACTERS]
    return f'<c r="{reference}" t="inlineStr"{style_attr}><is><t xml:space="preserve">{escape(text)}</t></is></c>'


def _write_sheet(
    stream: Any,
    rows: Iterable[tuple[dict[str, Any], str]],
    row_count: int,
    headers: tuple[str, ...] = EXCEL_HEADERS,
) -> None:
    stream.write(
        ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
         '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
         '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" '
         'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'
         '<col min="1" max="1" width="8" customWidth="1"/>'
         '<col min="2" max="4" width="24" customWidth="1"/>'
         '<col min="5" max="5" width="60" customWidth="1"/>'
         '<col min="6" max="7" width="42" customWidth="1"/>'
         f'<col min="8" max="{len(headers)}" width="22" customWidth="1"/>'
         '</cols><sheetData>').encode("utf-8")
    )
    header_cells = "".join(
        _cell_xml(f"{_column_name(column)}1", header, style=1)
        for column, header in enumerate(headers, start=1)
    )
    stream.write(f'<row r="1">{header_cells}</row>'.encode("utf-8"))
    for excel_row, (candidate, scan_status) in enumerate(rows, start=2):
        cells = "".join(
            _cell_xml(f"{_column_name(column)}{excel_row}", value)
            for column, value in enumerate(
                _row_values(candidate, excel_row - 1, scan_status, headers),
                start=1,
            )
        )
        stream.write(f'<row r="{excel_row}">{cells}</row>'.encode("utf-8"))
    stream.write(f'</sheetData><autoFilter ref="A1:{_column_name(len(headers))}{row_count + 1}"/></worksheet>'.encode("utf-8"))


def build_stage_one_excel(run: BullpenAutoLiveRun, scope: str = "all-scanned", enrich_missing: bool = False, *, enrichment_budget_seconds: float = 420) -> tuple[Path, str, int]:
    accepted, rejected, row_count = _candidate_rows(run)
    # Copy export rows before supplementing absent fields; frozen run is untouched.
    accepted = [dict(row) for row in accepted]
    rejected = [dict(row) for row in rejected]
    if enrich_missing:
        from app.domains.polymarket_auto_live.stage_one_export_enrichment import enrich_export_rows
        try:
            enrich_export_rows(accepted if scope == "filtered" else accepted + rejected, budget_seconds=enrichment_budget_seconds)
        except Exception as exc:
            # Source availability must never prevent downloading saved scan evidence.
            logging.getLogger(__name__).warning("Stage 1 export enrichment unavailable: %s", type(exc).__name__)
            for row in accepted if scope == "filtered" else accepted + rejected:
                row.setdefault("export_metadata", {"source": "Saved scan", "fetchedAt": "N/A", "status": "Current source lookup unavailable; saved values retained."})
    headers = _export_headers([*accepted, *rejected])
    if scope == "filtered":
        rejected = []
        row_count = len(accepted)
    timestamp = datetime.fromisoformat(
        (run.completed_at or run.started_at).strip().replace("Z", "+00:00")
    )
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=ZoneInfo("UTC"))
    stamp = timestamp.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H-%M-%SZ")
    filename = f"bullpen-stage-1-{scope}-events-{stamp}.xlsx"
    handle = tempfile.NamedTemporaryFile(prefix="bullpen-stage-one-", suffix=".xlsx", delete=False)
    handle.close()
    path = Path(handle.name)
    try:
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as workbook:
            workbook.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
            workbook.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
            workbook.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="All Scanned Events" sheetId="1" r:id="rId1"/></sheets></workbook>')
            workbook.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
            workbook.writestr("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/><color rgb="FF14532D"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F3EA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>')
            workbook.writestr("xl/sharedStrings.xml", '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" uniqueCount="1"><si><t>N/A</t></si></sst>')
            with workbook.open("xl/worksheets/sheet1.xml", "w", force_zip64=True) as sheet:
                _write_sheet(sheet, _iter_candidates(accepted, rejected), row_count, headers)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path, filename, row_count


def remove_export(path: Path) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
