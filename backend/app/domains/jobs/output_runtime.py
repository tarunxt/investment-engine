"""Scoped deterministic formatting for the current declared workflow schemas.

This context never goes to a provider or telemetry store. Generic/custom output
contracts keep their existing path; only explicit current column contracts opt in.
"""
from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import asdict, dataclass, replace
from collections import Counter
from datetime import datetime, timezone
import re
from typing import Any, Mapping
from zoneinfo import ZoneInfo

from app.domains.jobs.output_contracts import (
    CONTRACT_VERSION, NormalizationResult, REBALANCE_COLUMNS, SWING_COLUMNS,
    contract_hash, normalize_output, source_hash,
)
from app.domains.jobs.output_contracts.document import parse_markdown, split_row
from app.domains.jobs.output_contracts.schemas import Finding
from app.domains.jobs.output_contracts.consistency import FrozenSwingSource, inspect_output_consistency
from app.domains.jobs.output_sources import frozen_sources_from_context
from app.domains.jobs.output_contracts.validation import aliases, header_key, identity, prepare_holdings
from app.domains.runs.run_identity import analysis_run_identity


@dataclass(frozen=True)
class OutputContext:
    kind: str
    metadata: Mapping[str, Any]
    holdings: tuple[Mapping[str, Any], ...] | None
    expected_rows: int | None
    swing_sources: tuple[FrozenSwingSource, ...] | None = None


_context: ContextVar[OutputContext | None] = ContextVar('validated_output_context', default=None)


class OutputPreflightError(ValueError):
    """Frozen job inputs cannot be repaired by resending a paid generation."""


def current_output_context() -> OutputContext | None:
    return _context.get()


def _instruction_prefix(prompt: str) -> str:
    return re.split(r'(?im)^#\s+Inputs considered|^##\s*Rebalance Input Bundle|^##\s*1\.\s*Latest Portfolio Snapshot', prompt, maxsplit=1)[0]


def declares_output_contract(prompt: str, kind: str) -> bool:
    if kind not in {'swing', 'rebalance'}:
        return False
    columns = SWING_COLUMNS if kind == 'swing' else REBALANCE_COLUMNS
    known = aliases(columns)
    expected = tuple(column.key for column in columns)
    for line in _instruction_prefix(prompt).splitlines():
        if '|' in line and tuple(known.get(header_key(cell)) for cell in split_row(line)) == expected:
            return True
    return False


def holdings_from_prompt(prompt: str) -> tuple[Mapping[str, Any], ...] | None:
    match = re.search(r'(?is)##\s*1\.\s*Latest Portfolio Snapshot(?P<body>.*?)(?:\n##\s*2\.|\Z)', prompt)
    if match is None:
        return None
    blocks, findings = parse_markdown(match.group('body'))
    tables = []
    for block in blocks:
        headers = [header_key(header) for header in block.headers]
        if block.kind == 'table' and 'stock symbol' in headers and 'current units' in headers:
            tables.append((block, headers))
    if len(tables) != 1:
        return None
    block, headers = tables[0]
    if any(f.severity == 'error' and not (
        f.code == 'empty_table' and f.source is not None
        and f.source.fragment == block.index and not block.rows
    ) for f in findings):
        return None
    exchange_name = 'exchange' if 'exchange' in headers else 'exchange symbol'
    if exchange_name not in headers:
        return None
    indices = {key: headers.index(header) for key, header in {
        'exchange_symbol': exchange_name, 'stock_symbol': 'stock symbol', 'current_units': 'current units',
    }.items()}
    if len(headers) != len(set(headers)):
        return None
    # A valid, explicitly present empty table is a known empty snapshot.
    return tuple({key: row[index] for key, index in indices.items()} for row in block.rows)


def configure_output_context(job: Any, dimensions: Mapping[str, str | None]) -> Token | None:
    kind = analysis_run_identity(job).stage
    prompt = getattr(job, 'prompt', '') or ''
    if kind not in {'swing', 'rebalance'} or not declares_output_contract(prompt, kind):
        return _context.set(None)
    holdings = holdings_from_prompt(prompt) if kind == 'rebalance' else None
    if kind == 'rebalance':
        _, findings = prepare_holdings(holdings)
        if any(f.severity == 'error' for f in findings):
            raise OutputPreflightError('Authoritative holdings snapshot is missing or invalid; refresh inputs before starting a rebalance.')
    metadata: dict[str, Any] = {}
    provider, model = getattr(job, 'provider', None), getattr(job, 'model', None)
    if provider and model:
        metadata.update(llm_name_model=f'{provider}/{model}', llm=f'{provider}/{model}')
    run_id = dimensions.get('run_id')
    number = int(run_id) if isinstance(run_id, str) and run_id.isdigit() else getattr(job, 'id', None)
    if isinstance(number, int) and not isinstance(number, bool):
        metadata['run_number'] = number
    created = getattr(job, 'created_at', None)
    if isinstance(created, datetime):
        created = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
        local = created.astimezone(ZoneInfo('Asia/Kolkata'))
        metadata.update(run_date=local.strftime('%Y-%m-%d'), run_time=local.strftime('%H:%M:%S'))
    counts = {int(value) for value in re.findall(r'(?i)\b(?:choose|select)\s+exactly\s+([1-9][0-9]*)\s+(?:unique\s+)?stocks?\b', _instruction_prefix(prompt))} if kind == 'swing' else set()
    expected = next(iter(counts)) if len(counts) == 1 else None
    sources = frozen_sources_from_context(getattr(job, 'request_context_json', None),
                                          market=analysis_run_identity(job).market)
    return _context.set(OutputContext(kind, metadata, holdings, expected, sources))


def reset_output_context(token: Token | None) -> None:
    if token is not None:
        _context.reset(token)


def active_contract_hash() -> str | None:
    context = current_output_context()
    return contract_hash(context.kind) if context else None


def normalize_runtime_output(content: str, *, kind: str | None = None, fragment: bool = False) -> NormalizationResult | None:
    context = current_output_context()
    if context is None or kind is not None and context.kind != kind:
        return None
    result = normalize_output(content, context.kind, metadata=context.metadata,
                              holdings=context.holdings, derive_arithmetic=True,
                              minimum_rows=1 if fragment or context.kind == 'rebalance' else context.expected_rows or 5)
    findings = list(result.findings)
    if not fragment and context.expected_rows is not None and result.coverage.canonical_rows != context.expected_rows:
        findings.append(Finding('requested_row_count', f'Requested exactly {context.expected_rows} stock rows; received {result.coverage.canonical_rows}. All source rows were retained.'))
    if context.kind == 'swing':
        identities = [identity(row.values) for row in result.rows]
        known = [value for value in identities if value is not None]
        if len(known) != len(set(known)):
            findings.append(Finding('duplicate_stock_identity', 'A single stock selection contains repeated exchange/symbol identities; no row was discarded.'))
    if len(findings) != len(result.findings):
        result = replace(result, status='blocked', content=content, findings=tuple(findings))
    return result


def merge_swing_fragments(original: str, supplemental: str) -> str:
    """Preserve both deliveries; never truncate or choose a conflicting row."""
    first = normalize_runtime_output(original, kind='swing', fragment=True)
    second = normalize_runtime_output(supplemental, kind='swing', fragment=True)
    left = first.content if first and first.safe_to_replace else original
    right = second.content if second and second.safe_to_replace else supplemental
    return left.rstrip() + '\n\n' + right.lstrip()


def contract_issue(result: NormalizationResult) -> str:
    errors = [finding for finding in result.findings if finding.severity == 'error']
    context = current_output_context()
    target_rows = (context.expected_rows if context else None) or 5
    prefix = 'insufficient recommendations' if errors and all(f.code in {'insufficient_rows', 'requested_row_count'} for f in errors) and result.coverage.canonical_rows < target_rows else 'invalid output contract'
    detail = '; '.join(f'{finding.code}: {finding.message}' for finding in errors[:4])
    return f'{prefix} ({detail})'


def output_validation_metadata(content: str | None) -> dict[str, Any] | None:
    """Coverage is observed row/fragment accounting, never a quality verdict."""
    if not content:
        return None
    result = normalize_runtime_output(content)
    if result is None:
        return None
    return {
        'version': CONTRACT_VERSION,
        'schema_hash': active_contract_hash(),
        'response_hash': source_hash(content),
        'status': result.status,
        'safe_to_render': result.safe_to_replace,
        'coverage': asdict(result.coverage),
        'finding_counts': dict(Counter(f.code for f in result.findings)),
        'semantic_research_quality': 'not_evaluated',
        'consistency': asdict(inspect_output_consistency(
            result, swing_sources=current_output_context().swing_sources,
        )),
    }
