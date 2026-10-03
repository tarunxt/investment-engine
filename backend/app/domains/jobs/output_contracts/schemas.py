"""Versioned, explicit output columns; no provider, database or trading decisions."""

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class Column:
    key: str
    label: str


_COMMON = (
    Column("technical_setup", "Technical Setup"),
    Column("entry_range", "Entry Range"),
    Column("stop_loss", "Stop Loss"),
    Column("target", "Target"),
    Column("analyst_source", "Analyst Source"),
    Column("units_to_buy", "Units to Buy"),
    Column("price_per_unit", "Price per Unit"),
    Column("total_buy_amount", "Total Buy Amount"),
    Column("upside_horizon", "Upside Horizon (%)"),
    Column("weeks", "Weeks"),
    Column("confidence_score", "Confidence Score (0-100)"),
    Column("rationale_remarks", "Rationale Cruxx"),
    Column("score_rationale_cruxx", "Score Rationale Cruxx"),
)
_MEDIUM_LONG = (
    Column("rationale_technical_medium_term", "Rationale - Technical Setup (Medium Term)"),
    Column("score_rationale_technical_medium_term", "Score Rationale - Technical Setup (Medium Term)"),
    Column("rationale_technical_long_term", "Rationale - Technical Setup (Long Term)"),
    Column("score_rationale_technical_long_term", "Score Rationale - Technical Setup (Long Term)"),
    Column("rationale_fundamentals_short_term", "Rationale - Fundamentals Short Term"),
    Column("score_rationale_fundamentals_short_term", "Score Rationale - Fundamentals Short Term"),
    Column("rationale_fundamentals_medium_long_term", "Rationale - Fundamentals Medium/Long Term"),
    Column("score_rationale_fundamentals_medium_long_term", "Score Rationale - Fundamentals Medium/Long Term"),
)
_SHORT = (
    Column("rationale_technical_short_term", "Rationale Technical Setup Short Term 1–3 Months"),
    Column("score_rationale_technical_short_term", "Score Rationale Technical Setup Short Term 1–3 Months"),
)
SWING_COLUMNS = (
    Column("llm_name_model", "LLM Name + Model"),
    Column("exchange_symbol", "Exchange Symbol"),
    Column("stock_symbol", "Stock Symbol"),
    Column("stock_name", "Stock Name"),
    *_COMMON,
    *_MEDIUM_LONG,
    *_SHORT,
    Column("run_number", "Run #"),
    Column("run_date", "Run Date"),
    Column("run_time", "Run Time"),
    Column("llm", "LLM"),
)
REBALANCE_COLUMNS = (
    Column("exchange_symbol", "Exchange Symbol"),
    Column("stock_symbol", "Stock Symbol"),
    Column("current_units", "Current Units"),
    Column("action", "Action (Buy/Add/Sell All/Trim/Hold/Buy New)"),
    Column("units_change", "Units Change"),
    Column("final_units", "Final Units"),
    *(Column(c.key, {"analyst_source": "Analyst/Source", "price_per_unit": "Price Per Unit",
                     "upside_horizon": "Upside Horizon (% return)"}.get(c.key, c.label)) for c in _COMMON),
    *_SHORT,
    *_MEDIUM_LONG,
)
METADATA_KEYS = frozenset({"llm_name_model", "llm", "run_number", "run_date", "run_time"})
SCORE_KEYS = frozenset(c.key for c in SWING_COLUMNS if c.key.startswith("score_rationale_"))
NUMERIC_KEYS = SCORE_KEYS | frozenset({
    "stop_loss", "target", "units_to_buy", "price_per_unit", "total_buy_amount",
    "upside_horizon", "weeks", "confidence_score", "current_units", "units_change", "final_units",
})


@dataclass(frozen=True)
class Provenance:
    fragment: int
    row: int
    line: int | None


@dataclass(frozen=True)
class Finding:
    code: str
    message: str
    severity: str = "error"
    source: Provenance | None = None
    field: str | None = None


@dataclass(frozen=True)
class Block:
    """Ordered source fragment. text is always the unchanged source substring."""

    index: int
    kind: str
    text: str
    headers: tuple[str, ...] = ()
    rows: tuple[tuple[Any, ...], ...] = ()
    line: int | None = None


@dataclass(frozen=True)
class CanonicalRow:
    values: Mapping[str, Any]
    source_values: Mapping[str, Any]
    source: Provenance
    filled_fields: tuple[str, ...] = ()
    valid: bool = False


@dataclass(frozen=True)
class CanonicalTable:
    fragment: int
    columns: tuple[Column, ...]
    rows: tuple[CanonicalRow, ...]


@dataclass(frozen=True)
class Coverage:
    source_fragments: int
    preserved_fragments: int
    source_rows: int
    canonical_rows: int
    validated_rows: int
    expected_holdings: int | None
    covered_holdings: int | None


@dataclass(frozen=True)
class NormalizationResult:
    status: str
    original: str
    content: str
    blocks: tuple[Block, ...]
    tables: tuple[CanonicalTable, ...]
    findings: tuple[Finding, ...]
    coverage: Coverage

    @property
    def safe_to_replace(self) -> bool:
        return self.status == "valid"

    @property
    def rows(self) -> tuple[CanonicalRow, ...]:
        return tuple(row for table in self.tables for row in table.rows)


@dataclass(frozen=True)
class ExportTable:
    fragment: int
    headers: tuple[str, ...]
    rows: tuple[tuple[Any, ...], ...]
    provenance: tuple[Provenance, ...]
