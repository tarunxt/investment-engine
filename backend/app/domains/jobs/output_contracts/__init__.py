"""Offline, information-preserving rendering for validated stock outputs."""

from .document import parse_markdown, render_document
from .normalize import CONTRACT_VERSION, contract_hash, export_tables, normalize_output, source_hash
from .schemas import REBALANCE_COLUMNS, SWING_COLUMNS, NormalizationResult

__all__ = [
    "CONTRACT_VERSION", "SWING_COLUMNS", "REBALANCE_COLUMNS", "NormalizationResult",
    "contract_hash", "source_hash", "normalize_output", "export_tables", "parse_markdown", "render_document",
]
