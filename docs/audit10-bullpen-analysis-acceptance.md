# Audit10 Bullpen analysis lane

Base: fresh origin/main `8d25f34a33242adcaab092afdb07af7956f327bd`.
Branch: `work/bullpen-analytics-20261101`. Synthetic fixtures only.

These are separate recommendation deliverables, not closure of parent findings.
External task dedupe remains with the sole task writer. This lane does not merge,
deploy, approve a PR, run a migration, replay history or contact live providers.

| ID | Implementation / acceptance evidence | Remaining gate |
|---|---|---|
| A10-002-R01 | `generate_bullpen_post_trade_analysis` returns descriptive review leads, unknown calibration and no learning/policy flags. Parameterized single-outcome tests cover unknown/zero/positive/negative P&L and confidence; high-confidence loss retains review alert. Repository search found flags only in analysis storage/API/frontend types and tests, no automatic policy consumer. | Independent review/exact-head CI; historical flags are preserved as original evidence, not rewritten. |
| A10-002-R03 | Learning output always insufficient, no validated recommendations. Raw known-outcome tag/strategy statistics remain; additional tag population counts include zero/unknown outcomes. Cohort fixtures exercise single, selected winners, same event, stake/cost/model differences and mixed outcomes. Limits name unmatched dollars, dependence, model mixing, uncertainty/selection/multiplicity and independent chronological test. | Positive enablement blocked by Q2, A10-002-R02, A10-001-R04/R05 and real comparable independent evidence. No thresholds invented. |
| A10-003-R01 | Typed exit evidence preserves raw maximum/fill/requested values and declared units. Unit conversion tests show 50 cents = .50 unit price, keep zero, and abstain for invalid/missing units. Explicit execution summary no longer fills from requested price/shares/amount. | Historical generic `price`/units are unverified and withheld; historical data is not repaired/backfilled. |
| A10-003-R02 | Exit timing always Not evaluated; no EARLY_EXIT or hold-longer advice. In-hold maximum separately labelled raw/descriptive. Fixtures show suppression across absent fill and temporal/liquidity/cost scenarios. | Positive counterfactual blocked by unapproved horizon and missing timestamped executable bid/size/spread/fee contract. No hindsight tuning. |
| A10-004-R01 | Nullable exit P&L and returns; closed/known/unknown denominators and selected scope. Synthetic 2-closed/1-known/1-unknown and zero/non-win fixtures; open/unknown populations retained. IDs and timestamps are not changed by analysis reads. | Existing partial-close lifecycle is not redesigned. Complete partial-close acceptance needs the outcome policy owner's contract; full linked finding remains open. |
| A10-004-R02 | Nullable buy/sell total fees, measured component subtotal and coverage. Cost combinations include all unknown, known zero/missing, all zero and nonzero. Unknown fees cannot support a new complete net P&L. Frontend names recorded subtotal/coverage and cost scope. | No new tax/spread/FX estimates. Existing stored totals are preserved as recorded, not retrospectively verified. |
| A10-004-R03 | Null/zero confidence and missing outcome are distinct raw inputs; calibration always Not evaluated. Missing P&L has no fabricated zero gain. Frontend renders unknown alignment as Not evaluated. | Calibration definition remains Q2. |
| A10-S01 | Existing snapshot table reused; explicit recompute appends `ANALYSIS_VERSION` with labelled version/time/inputs; GET has no commit or record mutation. SQLite async lifecycle verifies repeated safe reads, two append-only revisions, unchanged original summary/category/metadata, null lineage and retained source identity. | No migration or bulk backfill required/attempted. Coordinator owns review/integration and retention decisions. |

Verification: isolated Python environment with pinned backend dependencies, SQLite
synthetic lifecycle and route/failure fixtures. See PR validation for exact final
commands/counts. Frontend changes are limited to nullable types and review labels;
no trading, auth, worker, sizing or run decision path is modified.

Final local checks:

- `PYTHONPATH=backend /tmp/bullpen-test-env/bin/python -m pytest backend/tests/test_bullpen_analysis_evidence.py backend/tests/test_bullpen_trade_analysis.py backend/tests/test_bullpen_trade_analysis_tasks.py -q --disable-warnings`: **58 passed**, including actual SQLite capture/detail/revision lifecycle and failed-reader recovery paths.
- `frontend/node_modules/.bin/tsc --noEmit` from `frontend`: passed.
- Scoped ESLint for both changed TradeAnalysis client components: passed.
- `git diff --check`: passed.
- Executed fresh-main analytics in isolation with synthetic inputs to reproduce single-loss calibration, single-win confidence increase, n=1 tag-weight advice, cents/unit EARLY_EXIT, missing P&L zero gain and missing-confidence positive alignment before confirming revised fixtures.

Reviewable commit organization: backend analysis/contracts/lifecycle fixtures and
run-audit documentation; frontend coverage/review labels and nullable types;
per-recommendation acceptance ledger. All must be integrated together after the
coordinator's auth-first independent review and exact-head CI gates.
