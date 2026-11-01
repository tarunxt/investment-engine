# A12 API accounting lane checkpoint

Base inspected: origin/main `8d25f34a33242adcaab092afdb07af7956f327bd` (fresh fetch 2026-11-01). No loaded production runtime or report receipt was accessed. No migrations, provider calls, account refreshes, worker operations, merge or deployment occurred. Auth behavior is unchanged. This is a scoped implementation checkpoint, not A12-V01 closure.

## Individually tracked action results

| Action | Result and remaining acceptance |
| --- | --- |
| A12-001.01 | Current-source comparison complete against fresh main; adapter legacy `actual_cost` is still read without rewriting history. Loaded-runtime comparison requires coordinator's authorized read-only acceptance. |
| A12-001.02 | Additive cost provenance distinguishes tariff estimate, provider-day total and allocation; settlement remains null. Compatibility measurement enums retained. Legacy tariff version/effective date are explicitly unknown; adapter emission of complete versioned provenance remains open. |
| A12-001.03 | Explicit window, exclusive end and read cutoff; invocation completeness and hidden SDK retries remain unknown. Bounded failed/cancelled lifecycle coverage is returned separately. Historical source-selection cutoff remains only to preserve financial values, explicitly not a completeness claim. |
| A12-001.04 | Existing bounded coverage/identity deduplication reused in owner-filtered read. Attempt estimates are not added to legacy totals, avoiding double counting. Existing canonical/duplicate/sample tests pass; cross-ledger unification remains open. |
| A12-001.05 | Estimate/provider-total/allocation UI labels fixed; existing stale retention, retries, nullable FX, IST and history retained. Legacy cache-field provenance explicitly unknown. Per-field reported/inferred cache display and tariff source freshness remain open. |
| A12-001.06 | Existing coverage, attempt, reconciliation and timezone suites plus new SQL/window fixtures pass under pytest. Existing incomplete/duplicate/sample/error/missing/zero/cache-conflict tests retained. Browser component fixture covers real rendering/failure/retry. New exhaustive adapter-to-UI scenario matrix remains open. |
| A12-001.07 | Deferred: coordinated release identity and safe live keyboard/narrow acceptance required; offline real component keyboard/375px fixture passes. |
| A12-002.01 | Fake SQL instrumentation reproduces four all-provider full-entity baseline reads; 16 accounting statements across four providers. Full before/after bytes and memory baseline remain open. |
| A12-002.02 | Provider-filtered scalar chart queries replace repeated all-provider entity reads; owner predicates in SQL. Four accounting statements per provider remain, rather than claiming grouped-query savings. |
| A12-002.03 | Chart reads select no prompt/output. Legacy history day/run reads restrict ORM columns; run history/detail semantics retained. Source precedence and totals unchanged. |
| A12-002.04 | Day-window accounting scans are complete within requested 1–100 calendar days and never limited by run_limit. Legacy bounded history pagination retained. No new unlimited-history cursor is introduced. |
| A12-002.05 | All four controls retained; successful provider results apply immediately before peers finish. Breakdown component loading/error/keyboard retry/stale/narrow fixture passes. Full page delayed-provider lifecycle fixture remains open. |
| A12-002.06 | 1/10/1000-row SQL fixture verifies four accounting statements, zero prompt/output selection, ownership/provider predicates, no LIMIT and exact totals; records bytes/peak allocations. Full page delayed-provider and before/after memory comparison remain open. |
| A12-002.07 | Deferred: no retained production trace was available in this environment; trend failure cause is unproven. No production load or latency claim. |

## Verification

Run from repository root:

```
PYTHONPATH=backend /tmp/a12-venv/bin/python -m pytest backend/tests/test_api_usage_coverage.py backend/tests/test_api_usage_reconciliation.py backend/tests/test_api_usage_chart_projection.py backend/tests/test_api_usage_timezones.py backend/tests/test_api_usage_attempts.py -q -s
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node frontend/scripts/api-accounting-offline-playwright.mjs
```

119 backend tests passed (8 dependency deprecation warnings). Browser fixture passed against actual LlmUsageBreakdown with mocked reads and zero external requests. ESLint checks changed frontend source and fixture. No live data was used.

Synthetic accounting projection measurements (not route latency, not production memory, and not a comparative savings claim):

| Rows | Accounting statements | Serialized internal row bytes | tracemalloc peak bytes |
| ---: | ---: | ---: | ---: |
| 1 | 4 | 505 | 173559 |
| 10 | 4 | 5050 | 49991 |
| 1000 | 4 | 506890 | 813183 |

Mapper registration occurs before measurement; first-statement compilation still affects the first sample. Cost-history additionally retains its legacy day/run/count reads and now one bounded attempt-coverage read. These are not included in the four-statement projection metric. Totals are not truncated to achieve a size budget.

## Integration boundary

Coordinator owns auth-first serialization, independent review, exact-head CI, merge, deployment and safe live evidence. Neither recommendation is closed. No formal PR approval is supplied. No runtime access or separate security/policy authorization is requested by this checkpoint.

## Follow-up: provenance, full selected-window read and actual-page acceptance

This section supersedes the implementation gaps in the initial checkpoint above. Fresh main remains `8d25f34a` on re-fetch. No live/provider/billing access occurred.

| Action | Current result |
| --- | --- |
| A12-001.01 | Fresh source inspected; loaded-runtime comparison remains coordinator acceptance. |
| A12-001.02 | New metered adapter attempts persist schema-v1 tariff provenance with deterministic rate-snapshot hash, USD-per-million units, unknown effective date, unverified repository freshness and null billed charge. Existing legacy tariff_version and numeric fields remain untouched. Actual DeepSeek adapter tests use mocked SDK responses, including missing/zero/malformed cache usage. |
| A12-001.03 | Complete selected persisted event window uses one streaming SQL statement, 1000-row driver batches, read cutoff and no accounting LIMIT. Started events use start time; finished events use finish time, including cross-midnight failures. Full persisted read is distinct from unknown invocation/invoice completeness. Interrupted reads fail instead of returning complete/zero data. |
| A12-001.04 | Shared incremental accumulator retains lifecycle and provider identity state across fetch batches. The original 31 bounded pure tests still pass. 10005 persisted events verify no truncation, exact deduplicated subtotals, independent samples, errors/cancellations and ownership/provider boundaries. Attempt estimates remain separate from legacy totals. |
| A12-001.05 | Actual breakdown component displays reported versus inferred cache tokens (including reported zero), version/freshness, read cutoff and complete persisted-read versus unknown invoice coverage. Existing stale/error/retry/native USD/nullable FX/run history behavior retained. Historical fields without source evidence remain unknown. |
| A12-001.06 | 144 relevant backend tests pass, including real SQLite persisted reads, mocked actual DeepSeek execution, prior reconciliation/timezone/identity tests and comparative projection fixtures. Actual component failure/keyboard/narrow and provenance-label fixture passes. |
| A12-001.07 | Offline keyboard/narrow acceptance passes. Deployed identity and safe live acceptance remain coordinator release gates. |
| A12-002.01 | Actual persisted synthetic SQLite fixtures compare four-provider baseline and compact reads at 1/10/1000 jobs per provider, with SQL statements, selected-value JSON size, hydrated entities, daily-total serialization and instrumented peak memory measured. |
| A12-002.02 | Owner/provider-filtered compact reads complete; 16 accounting statements across four providers for either path, without all-provider entity hydration in the compact path. |
| A12-002.03 | Chart selects zero prompt/response columns. Exact provider/day totals match baseline; legacy history/detail paths and source precedence retained. |
| A12-002.04 | Complete selected day-window scans are independent of run_limit. Full streaming attempt coverage has no row cap. Legacy run pagination remains bounded and unchanged. |
| A12-002.05 | Actual ApisPage and CombinedLlmCostChart fixture proves one provider is usable while three peers remain pending, all four keyboard controls, partial failure, empty provider, retry and stale retention at 1180/375px. Zero external requests/writes/errors. |
| A12-002.06 | Comparative persisted fixtures assert exact provider/day and aggregate totals; actual page lifecycle fixture passes. Measurements below are synthetic, not production claims. |
| A12-002.07 | Runtime trend trace/root cause and comparable safe live route latency remain unverified; no paid or live measurement performed. |

### Shared source contract for cost-dashboard ownership

No cost-dashboard-owned files or database schemas were changed. Consumers can reuse:

- `api_usage.provenance.tariff_provenance(rates)` and `cache_provenance(reported, inferred)`; schema version 1. New attempts store these in existing `inferred_usage.accounting_provenance` and `inferred_usage.cache_fields`. The legacy top-level tariff tag remains backward compatible; `rate_version` identifies exact stored numeric rate snapshots. Effective dates and settlement are explicitly unknown.
- `api_usage.window_coverage.load_window_attempt_coverage(...)`; schema version 1. `persisted_read_state=complete` means the entire selected statement snapshot was consumed, while `invocation_coverage_state=unknown` and `invoice_total_usd=null` remain separate. Lifecycle/identity state grows with unique attempts to preserve exact reconciliation; only driver fetch batches are fixed-size. Consumers must not sum independently deduplicated batch reports or add attempt estimates to legacy provider-day totals.

No missing billing evidence blocks completion of these code contracts. Historical provider invoice completeness, verified tariff effective dates, hidden SDK retries and original absent fields cannot be manufactured from saved telemetry. They remain explicit unknowns; no backfill or billing export was performed.

### Comparative persisted fixture evidence

These are Python JSON encodings of selected synthetic values, not database wire bytes. Memory includes test instrumentation and first-query setup; no production speedup is claimed.

| Rows/provider | Statements baseline/compact | Selected JSON bytes baseline/compact | Peak bytes baseline/compact | Identical daily totals JSON bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 16 / 16 | 80764 / 457 | 7954803 / 240506 | 421 |
| 10 | 16 / 16 | 807308 / 4385 | 985135 / 178547 | 429 |
| 1000 | 16 / 16 | 80759596 / 443917 | 71724242 / 2470130 | 849 |

At 1000 rows/provider, baseline hydrated 16000 full job entities across the fan-out; compact hydrated zero job entities and selected no prompt/response. Both retained identical provider/day values, including failed jobs, request-attempt counts and owner filtering.

Additional runnable fixtures:

```
PYTHONPATH=backend /tmp/a12-venv/bin/python -m pytest backend/tests/test_api_usage_selected_window.py backend/tests/test_api_usage_projection_comparison.py -q -s
CHROMIUM_PATH=/usr/bin/chromium node frontend/scripts/api-accounting-page-offline-playwright.mjs
```

The test environment uses aiosqlite 0.22.1, already listed in repository CI dependency installation. Browser evidence is synthetic only under `/tmp/a12-api-page-evidence/`; it was not published. TypeScript noEmit and changed-file ESLint checks pass. The initial PR creation returned GitHub GraphQL Forbidden; it was not retried through any route. Neither recommendation is closed without coordinated deployed acceptance.
