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
