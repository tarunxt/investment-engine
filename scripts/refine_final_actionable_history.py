from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:100]!r}")
    write(path, content.replace(old, new, 1))


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise RuntimeError(f"Expected one regex match in {path}, found {count}: {pattern[:100]!r}")
    write(path, updated)


# One canonical row per user/market/run/stock. Formula version is audit metadata,
# not part of identity; a recovered suggestion upgrades a prior coverage row.
for path in (
    "backend/app/domains/runs/models.py",
    "backend/alembic/versions/b5c6d7e8f9g0_add_final_actionable_history.py",
):
    replace_once(
        path,
        '            "stock_symbol",\n            "formula_version",\n            name="uq_final_actionable_history_run_stock_formula",',
        '            "stock_symbol",\n            name="uq_final_actionable_history_run_stock",',
    )

# Remove an unused model import from the router.
replace_once(
    "backend/app/domains/runs/router.py",
    "    AutoRebalanceWorkflowStage,\n    FinalActionableHistory,\n    Run,",
    "    AutoRebalanceWorkflowStage,\n    Run,",
)

# Use a real PostgreSQL upsert for retry/concurrency safety.
replace_once(
    "backend/app/domains/runs/final_actionable_history.py",
    "from sqlalchemy import and_, or_, select\nfrom sqlalchemy.ext.asyncio import AsyncSession",
    "from sqlalchemy import and_, or_, select\nfrom sqlalchemy.dialects.postgresql import insert as pg_insert\nfrom sqlalchemy.ext.asyncio import AsyncSession",
)

regex_replace_once(
    "backend/app/domains/runs/final_actionable_history.py",
    r"async def persist_history_items\(.*?\n\nasync def list_stock_history\(",
    '''async def persist_history_items(
    db: AsyncSession,
    *,
    user_id: int,
    items: Sequence[FinalActionableHistoryCreateItem],
) -> tuple[int, int, int]:
    run_ids = {item.rebalance_run_id for item in items}
    technical_ids = {item.technical_scan_run_id for item in items if item.technical_scan_run_id}
    all_run_ids = run_ids | technical_ids
    owned_ids = set(
        (await db.execute(select(Run.id).where(Run.user_id == user_id, Run.id.in_(all_run_ids))))
        .scalars()
        .all()
    )
    if owned_ids != all_run_ids:
        raise ValueError("One or more referenced runs do not belong to the current user")

    existing_rows = list(
        (
            await db.execute(
                select(FinalActionableHistory).where(
                    FinalActionableHistory.user_id == user_id,
                    FinalActionableHistory.rebalance_run_id.in_(run_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    existing_by_key = {
        (row.market, row.rebalance_run_id, row.stock_symbol): row.coverage_status
        for row in existing_rows
    }

    known_rows = (
        await db.execute(
            select(FinalActionableHistory.market, FinalActionableHistory.stock_symbol)
            .where(FinalActionableHistory.user_id == user_id)
            .distinct()
        )
    ).all()
    known_by_market: dict[str, set[str]] = defaultdict(set)
    for market, symbol in known_rows:
        known_by_market[market].add(symbol)

    payload_by_key: dict[tuple[str, int, str], dict] = {}
    run_templates: dict[tuple[str, int], FinalActionableHistoryCreateItem] = {}
    submitted_symbols: dict[tuple[str, int], set[str]] = defaultdict(set)
    for item in items:
        symbol = normalize_stock_symbol(item.stock_symbol)
        key = (item.market, item.rebalance_run_id, symbol)
        run_key = (item.market, item.rebalance_run_id)
        run_templates.setdefault(run_key, item)
        submitted_symbols[run_key].add(symbol)
        known_by_market[item.market].add(symbol)
        payload_by_key[key] = {
            "user_id": user_id,
            "workflow_id": item.workflow_id,
            "auto_rebalance_sequence": item.auto_rebalance_sequence,
            "rebalance_run_id": item.rebalance_run_id,
            "market": item.market,
            "stock_symbol": symbol,
            "stock_name": item.stock_name,
            "covered_at": item.covered_at,
            "action": item.action,
            "score": item.score,
            "consensus_numerator": item.consensus_numerator,
            "consensus_denominator": item.consensus_denominator,
            "historical_current_units": item.historical_current_units,
            "historical_current_value": item.historical_current_value,
            "action_units": item.action_units,
            "amount": item.amount,
            "technical_scan_run_id": item.technical_scan_run_id,
            "formula_version": item.formula_version,
            "formula_inputs_json": item.formula_inputs_json,
            "source_run_ids_json": item.source_run_ids_json,
            "snapshot_json": item.snapshot_json,
            "coverage_status": item.coverage_status,
        }

    # Keep explicit gaps for symbols already known at the time of this write.
    # setdefault ensures a real suggestion always wins over a generated gap,
    # even when a large run is retried or split across request batches.
    for (market, run_id), template in run_templates.items():
        for symbol in sorted(known_by_market[market] - submitted_symbols[(market, run_id)]):
            key = (market, run_id, symbol)
            payload_by_key.setdefault(
                key,
                {
                    "user_id": user_id,
                    "workflow_id": template.workflow_id,
                    "auto_rebalance_sequence": template.auto_rebalance_sequence,
                    "rebalance_run_id": run_id,
                    "market": market,
                    "stock_symbol": symbol,
                    "covered_at": template.covered_at,
                    "formula_version": "coverage-v1",
                    "source_run_ids_json": [run_id],
                    "coverage_status": "not_mentioned",
                    "snapshot_json": {
                        "reason": "Stock was not mentioned in persisted output rows."
                    },
                },
            )

    payloads = list(payload_by_key.values())
    if not payloads:
        return 0, 0, 0

    statement = pg_insert(FinalActionableHistory).values(payloads)
    excluded = statement.excluded
    update_columns = (
        "workflow_id",
        "auto_rebalance_sequence",
        "stock_name",
        "covered_at",
        "action",
        "score",
        "consensus_numerator",
        "consensus_denominator",
        "historical_current_units",
        "historical_current_value",
        "action_units",
        "amount",
        "technical_scan_run_id",
        "formula_version",
        "formula_inputs_json",
        "source_run_ids_json",
        "snapshot_json",
        "coverage_status",
        "updated_at",
    )
    statement = statement.on_conflict_do_update(
        constraint="uq_final_actionable_history_run_stock",
        set_={column: getattr(excluded, column) for column in update_columns},
        where=and_(
            FinalActionableHistory.coverage_status != "suggested",
            excluded.coverage_status == "suggested",
        ),
    )
    await db.execute(statement)
    await db.commit()

    new_rows = sum(key not in existing_by_key for key in payload_by_key)
    upgrades = sum(
        key in existing_by_key
        and existing_by_key[key] != "suggested"
        and payload_by_key[key].get("coverage_status") == "suggested"
        for key in payload_by_key
    )
    persisted = new_rows + upgrades
    skipped = len(payload_by_key) - persisted
    coverage_inserted = sum(
        key not in existing_by_key
        and payload.get("coverage_status") != "suggested"
        for key, payload in payload_by_key.items()
    )
    return persisted, skipped, coverage_inserted


async def list_stock_history(''',
)

# Backfill in chronological order so a ticker is not labelled missing before it
# first appeared, and upgrade coverage rows without overwriting immutable live rows.
regex_replace_once(
    "backend/app/domains/runs/final_actionable_history.py",
    r"def backfill_user_history\(.*\Z",
    '''def backfill_user_history(db: Session, *, user_id: int) -> dict[str, int]:
    runs = list(
        db.execute(
            select(Run)
            .where(Run.user_id == user_id)
            .options(selectinload(Run.run_jobs).selectinload(RunJob.job))
            .order_by(Run.created_at.asc(), Run.id.asc())
        ).scalars().all()
    )
    eligible = [run for run in runs if is_rebalance_run(run) and infer_market(run)]
    existing_by_key = {
        (row.market, row.rebalance_run_id, row.stock_symbol): row
        for row in db.execute(
            select(FinalActionableHistory).where(FinalActionableHistory.user_id == user_id)
        ).scalars().all()
    }

    inserted = 0
    upgraded = 0
    coverage_inserted = 0
    seen_by_market: dict[str, set[str]] = defaultdict(set)
    for run in eligible:
        market = infer_market(run)
        if not market:
            continue
        projection, usable_output_seen = _run_projection(run)
        seen_by_market[market].update(projection)

        for symbol in sorted(seen_by_market[market]):
            data = projection.get(symbol)
            if data:
                formula_version = "legacy-backfill-v1"
                coverage_status = "suggested"
            else:
                formula_version = "coverage-v1"
                if status_value(run.status) == "failed":
                    coverage_status = "run_failed"
                elif usable_output_seen:
                    coverage_status = "not_mentioned"
                else:
                    coverage_status = "parse_failed"

            key = (market, run.id, symbol)
            existing = existing_by_key.get(key)
            if existing is not None:
                if data and existing.coverage_status != "suggested":
                    existing.stock_name = data.get("stock_name")
                    existing.action = data.get("action")
                    existing.score = data.get("score")
                    existing.consensus_numerator = data.get("consensus_numerator")
                    existing.consensus_denominator = data.get("consensus_denominator")
                    existing.historical_current_units = data.get("historical_current_units")
                    existing.historical_current_value = data.get("historical_current_value")
                    existing.action_units = data.get("action_units")
                    existing.amount = data.get("amount")
                    existing.formula_version = formula_version
                    existing.formula_inputs_json = {
                        "parser": "legacy-markdown-backfill-v1",
                        "source_job_ids": data.get("source_job_ids", []),
                    }
                    existing.source_run_ids_json = [run.id]
                    existing.snapshot_json = {
                        "source": "legacy-backfill",
                        "rows": data.get("rows", []),
                    }
                    existing.coverage_status = "suggested"
                    upgraded += 1
                continue

            record = FinalActionableHistory(
                user_id=user_id,
                auto_rebalance_sequence=run.auto_rebalance_sequence,
                rebalance_run_id=run.id,
                market=market,
                stock_symbol=symbol,
                stock_name=data.get("stock_name") if data else None,
                covered_at=run.created_at,
                action=data.get("action") if data else None,
                score=data.get("score") if data else None,
                consensus_numerator=data.get("consensus_numerator") if data else None,
                consensus_denominator=data.get("consensus_denominator") if data else None,
                historical_current_units=data.get("historical_current_units") if data else None,
                historical_current_value=data.get("historical_current_value") if data else None,
                action_units=data.get("action_units") if data else None,
                amount=data.get("amount") if data else None,
                formula_version=formula_version,
                formula_inputs_json={
                    "parser": "legacy-markdown-backfill-v1",
                    "source_job_ids": data.get("source_job_ids", []) if data else [],
                },
                source_run_ids_json=[run.id],
                snapshot_json={
                    "source": "legacy-backfill",
                    "rows": data.get("rows", []) if data else [],
                    "reason": None if data else coverage_status,
                },
                coverage_status=coverage_status,
            )
            db.add(record)
            existing_by_key[key] = record
            if data:
                inserted += 1
            else:
                coverage_inserted += 1
            if (inserted + upgraded + coverage_inserted) % 250 == 0:
                db.flush()

    db.commit()
    return {
        "runs_scanned": len(eligible),
        "suggestions_inserted": inserted,
        "suggestions_upgraded": upgraded,
        "coverage_inserted": coverage_inserted,
    }
''',
)

# Use the service's standard GET/POST helpers so JSON headers and auth behavior
# remain identical to other API methods.
replace_once(
    "frontend/services/api.ts",
    '''  async getFinalActionableHistory(params: {
    market: "india" | "us";
    symbol: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<FinalActionableHistoryListResponse> {
    const query = new URLSearchParams({
      market: params.market,
      symbol: params.symbol,
      limit: String(params.limit ?? 50),
    });
    if (params.cursor) query.set("cursor", params.cursor);
    return this.fetch<FinalActionableHistoryListResponse>(
      `${URLs.runs.finalActionableHistory()}?${query.toString()}`,
    );
  }

  async saveFinalActionableHistory(
    data: FinalActionableHistoryBulkCreateRequest,
  ): Promise<FinalActionableHistoryBulkCreateResponse> {
    return this.fetch<FinalActionableHistoryBulkCreateResponse>(
      URLs.runs.finalActionableHistory(),
      { method: "POST", body: JSON.stringify(data) },
    );
  }

  async queueFinalActionableHistoryBackfill(): Promise<FinalActionableHistoryBackfillResponse> {
    return this.fetch<FinalActionableHistoryBackfillResponse>(
      URLs.runs.finalActionableHistoryBackfill(),
      { method: "POST" },
    );
  }
''',
    '''  getFinalActionableHistory(params: {
    market: "india" | "us";
    symbol: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<FinalActionableHistoryListResponse> {
    const query = new URLSearchParams({
      market: params.market,
      symbol: params.symbol,
      limit: String(params.limit ?? 50),
    });
    if (params.cursor) query.set("cursor", params.cursor);
    return this.get<FinalActionableHistoryListResponse>(
      `${URLs.runs.finalActionableHistory()}?${query.toString()}`,
    );
  }

  saveFinalActionableHistory(
    data: FinalActionableHistoryBulkCreateRequest,
  ): Promise<FinalActionableHistoryBulkCreateResponse> {
    return this.post<FinalActionableHistoryBulkCreateResponse>(
      URLs.runs.finalActionableHistory(),
      data,
    );
  }

  queueFinalActionableHistoryBackfill(): Promise<FinalActionableHistoryBackfillResponse> {
    return this.post<FinalActionableHistoryBackfillResponse>(
      URLs.runs.finalActionableHistoryBackfill(),
      {},
    );
  }
''',
)

# Persist only the latest actionables group from the live UI. Older runs are
# reconstructed by the backfill from their original LLM responses, avoiding
# recalculation with today's holdings or formula settings.
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    '''async function persistFinalActionableHistoryRows(
  rows: HistoricalDashboardActionRow[],
  runs: RunResponse[],
) {
  const items = buildFinalActionableHistoryItems(rows, runs);
  for (let index = 0; index < items.length; index += 100) {
    await apiService.saveFinalActionableHistory({ items: items.slice(index, index + 100) });
  }
}
''',
    '''function getCurrentPersistableHistoryRows(
  rows: HistoricalDashboardActionRow[],
  runs: RunResponse[],
  market: SwingTradeMarket,
) {
  const latestRunIds = new Set(getLatestMatchingRuns(runs, market).map((run) => run.id));
  return rows.filter((row) => latestRunIds.has(row.runId));
}

async function persistFinalActionableHistoryRows(
  rows: HistoricalDashboardActionRow[],
  runs: RunResponse[],
) {
  const items = buildFinalActionableHistoryItems(rows, runs);
  for (let index = 0; index < items.length; index += 100) {
    await apiService.saveFinalActionableHistory({ items: items.slice(index, index + 100) });
  }
}
''',
)
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    '''    const allRows = [
      ...historicalActionRowsByMarket.india,
      ...historicalActionRowsByMarket.us,
    ];''',
    '''    const allRows = [
      ...getCurrentPersistableHistoryRows(
        historicalActionRowsByMarket.india,
        runs,
        "india",
      ),
      ...getCurrentPersistableHistoryRows(
        historicalActionRowsByMarket.us,
        runs,
        "us",
      ),
    ];''',
)
replace_once(
    "frontend/app/console/_components/FinalActionablesConsole.tsx",
    '''    if (historicalActionRows.length) {
      void persistFinalActionableHistoryRows(historicalActionRows, runs).catch((error) => {''',
    '''    const currentHistoryRows = getCurrentPersistableHistoryRows(
      historicalActionRows,
      runs,
      market,
    );
    if (currentHistoryRows.length) {
      void persistFinalActionableHistoryRows(currentHistoryRows, runs).catch((error) => {''',
)

# Extend regression coverage for canonical identity and current-only live writes.
path = "frontend/tests/final-actionables-history-persistence.test.mjs"
content = read(path)
content = content.replace(
    '  assert.match(source, /queueFinalActionableHistoryBackfill\\(/);\n',
    '  assert.match(source, /queueFinalActionableHistoryBackfill\\(/);\n'
    '  assert.match(source, /getCurrentPersistableHistoryRows\\(/);\n',
    1,
)
write(path, content)

# Remove the temporary workflow and this patcher from the implementation commit.
(ROOT / ".github/workflows/refine-final-actionable-history.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
