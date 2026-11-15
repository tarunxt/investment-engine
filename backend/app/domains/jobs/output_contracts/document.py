"""Lossless fragment capture and conservative Markdown/JSON table parsing."""

import html
import json
from decimal import Decimal
import re
from typing import Any

from .schemas import Block, CanonicalTable, Finding, Provenance


def split_row(line: str) -> tuple[str, ...]:
    """Split only unescaped pipes. Decode our renderer's HTML entities once."""
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|"):
        slash_count = len(text[:-1]) - len(text[:-1].rstrip("\\"))
        if slash_count % 2 == 0:
            text = text[:-1]
    cells: list[str] = []
    cell: list[str] = []
    i = 0
    while i < len(text):
        char = text[i]
        if char == "\\" and i + 1 < len(text) and text[i + 1] in "\\|":
            cell.append(text[i + 1])
            i += 2
            continue
        if char == "|":
            cells.append(html.unescape("".join(cell).strip()))
            cell = []
        else:
            cell.append(char)
        i += 1
    cells.append(html.unescape("".join(cell).strip()))
    return tuple(cells)


def _separator(line: str) -> bool:
    cells = split_row(line)
    return len(cells) > 1 and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def parse_markdown(content: str) -> tuple[tuple[Block, ...], list[Finding]]:
    """Keep every line and row, including malformed rows. Never deduplicate."""
    lines = content.splitlines(keepends=True)
    blocks: list[Block] = []
    findings: list[Finding] = []
    text_start = 0
    i = 0
    while i < len(lines):
        if i + 1 < len(lines) and "|" in lines[i] and _separator(lines[i + 1]):
            if text_start < i:
                blocks.append(Block(len(blocks), "text", "".join(lines[text_start:i]), line=text_start + 1))
            start = i
            headers = split_row(lines[i])
            index = len(blocks)
            if len(split_row(lines[i + 1])) != len(headers):
                findings.append(Finding("separator_width", "Header and separator widths differ.", source=Provenance(index, 0, i + 1)))
            i += 2
            rows: list[tuple[Any, ...]] = []
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                # A following header+separator starts a distinct source fragment.
                if i + 1 < len(lines) and _separator(lines[i + 1]):
                    break
                row = split_row(lines[i])
                rows.append(row)
                if len(row) != len(headers):
                    findings.append(Finding("row_width", f"Expected {len(headers)} cells; received {len(row)}.", source=Provenance(index, len(rows), i + 1)))
                i += 1
            if not rows:
                findings.append(Finding("empty_table", "Table has no data rows.", source=Provenance(index, 0, start + 1)))
            blocks.append(Block(index, "table", "".join(lines[start:i]), headers, tuple(rows), start + 1))
            text_start = i
            continue
        if lines[i].lstrip().startswith("|") and lines[i].count("|") >= 2:
            findings.append(Finding("unparsed_table_line", "Table-like line lacks an unambiguous header and separator.", source=Provenance(len(blocks), 0, i + 1)))
        i += 1
    if text_start < len(lines):
        blocks.append(Block(len(blocks), "text", "".join(lines[text_start:]), line=text_start + 1))
    return tuple(blocks), findings


def parse_json(content: str) -> tuple[tuple[Block, ...], list[Finding]]:
    """Accept only an explicit record array or a one-key record-array envelope."""
    findings: list[Finding] = []

    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                findings.append(Finding("duplicate_json_key", f"Duplicate JSON key {key!r} would lose information."))
            result[key] = value
        return result

    def checked_float(token: str) -> float:
        value = float(token)
        if Decimal(token) != Decimal(str(value)):
            findings.append(Finding("numeric_precision_loss", "A supplied decimal cannot be preserved by the export numeric representation; keep the original document."))
        return value

    try:
        data = json.loads(content, object_pairs_hook=unique_object, parse_float=checked_float)
    except (ValueError, TypeError, ArithmeticError):
        return (Block(0, "text", content),), [Finding("malformed_json", "Input is not valid JSON.")]
    if isinstance(data, dict):
        if len(data) != 1 or next(iter(data)) not in {"stocks", "rows", "recommendations"}:
            return (Block(0, "text", content),), [Finding("unsupported_json_envelope", "Envelope contains unrecognized fields; preserve it unchanged.")]
        data = next(iter(data.values()))
    if not isinstance(data, list) or not data:
        return (Block(0, "text", content),), [Finding("empty_or_unsupported_json", "Expected a nonempty JSON array of objects.")]
    headers = tuple(dict.fromkeys(key for record in data if isinstance(record, dict) for key in record))
    rows: list[tuple[Any, ...]] = []
    for index, record in enumerate(data, 1):
        if not isinstance(record, dict):
            findings.append(Finding("invalid_record", "Every JSON row must be an object.", source=Provenance(0, index, None)))
            rows.append((record,))
        else:
            # Missing is represented separately from an explicit JSON null.
            rows.append(tuple(record.get(key, MISSING) for key in headers))
    return (Block(0, "table", content, headers, tuple(rows)),), findings


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING = _Missing()


def cell_text(value: Any) -> str:
    if value is MISSING:
        return ""
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return text


def encode_cell(value: Any) -> str:
    # Encode ampersands first so literal entity strings survive a round trip.
    text = (html.escape(cell_text(value), quote=False).replace("\\", "&#92;").replace("|", "&#124;")
            .replace("\r", "&#13;").replace("\n", "&#10;").replace("\t", "&#9;"))
    # Boundary spaces inside JSON strings are data, not Markdown padding.
    return re.sub(r"^ +| +$", lambda match: "&#32;" * len(match.group()), text)


def render_table(table: CanonicalTable) -> str:
    lines = ["| " + " | ".join(encode_cell(column.label) for column in table.columns) + " |",
             "| " + " | ".join("---" for _ in table.columns) + " |"]
    lines.extend("| " + " | ".join(encode_cell(row.values.get(column.key, MISSING)) for column in table.columns) + " |" for row in table.rows)
    return "\n".join(lines)


def render_document(blocks: tuple[Block, ...], tables: tuple[CanonicalTable, ...] = ()) -> str:
    """Without replacements, reproduce the exact input including all prose."""
    replacements = {table.fragment: table for table in tables}
    return "".join(
        render_table(replacements[block.index]) + ("\n" if block.text.endswith(("\n", "\r")) else "")
        if block.index in replacements else block.text
        for block in blocks
    )
