# Audit 12 offline evidence lane

Source read on 2026-11-01: main and stated deployed baseline
`8d25f34a33242adcaab092afdb07af7956f327bd`. Branch:
`work/performance-evidence-20261101`. This lane changes only standalone helpers,
synthetic tests and this acceptance ledger. It does not include P1 polling branch
changes or pending auth PR 1391. Coordinator must check their exact identities at
integration; no deployment or host operation was performed here.

Retained repository evidence reviewed: `performance-results/after-local.json`,
`javascript-budget-baseline.json`, `performance-hardening-followup-summary.json`,
`docs/performance-hardening-followup.md`, the runtime performance collector, and
existing JavaScript budget checker. July history is not current candidate proof.
No approved current private trace, workflow timestamp extract, provider invoice,
backup resource receipt, or queue/CPU/RSS series was supplied to this checkout.
No private reports or receipts are included here. Absence in this checkout does
not assert absence in the coordinator's private evidence store.

## Per-ID deliverables and remaining gates

| ID | Implemented assessment / existing owner | Evidence still required; closure status |
| --- | --- | --- |
| A12-M01 | Offline condition comparison and distribution helpers. Explicit source, route, owner scope, input size, window, cache, CPU, network, viewport, build and environment required. Invalid samples excluded; p95 withheld below 20 valid samples. | Current matching route/API/DB/serialization/render samples with counts and independent workflow coverage. No N+1 or timeout conclusion. Not measured. A12-002 remains dependency. |
| A12-M02 | Explicit run/attempt timeline validator; separate queue/provider/polling/render boundaries, union accounting and unattributed residual. Missing/invalid intervals excluded, hidden SDK retries unknown. | Existing owner-safe US122 continuation and US121 interrupted timelines, skipped/reused stages and all attempts. Synthetic continuation/interrupted fixtures are not those saved runs. No whole-run SLA. Reuse P1 polling task 6hvMrPR9p2qCFhq8; no duplicate fix. |
| A12-M03 | Strict offline candidate adapter invokes existing byte gates after validating source SHA/build/environment/window and finite positive transferred/decoded bytes for login/dashboard/bullpen. | Actual current built candidate report; offline authenticated repeated render, heap growth, payload and large-data measurements under matched conditions. No frontend dependencies/build artifacts present, so no candidate build or browser measurement executed. All three routes require byte evidence; no unavailable third byte metric is invented. Synthetic checker success is not candidate success. Coordinate A12-005 owner before shared collector/CI edits. |
| A12-M04 | Acceptance attached here for existing task 6hhg5hVHmrVFjC28; no duplicate reconciliation implementation. | Existing provider-day/attempt and invoice joins, explicit usage cutoff, failed/cancelled attempts, cache, retry uncertainty, tool/search fees, model mix, tax/credits, nullable FX and unmatched components. Estimates, allocations and settled costs must remain separate. Missing is unknown, never free. Billing proof unavailable here; parent task and daily 2 Nov 10:00 checkpoint remain open/unchanged. |
| A12-M05 | Acceptance retained with sole backup owner 6hgRvX354W2Fm99g under 6hgRvWVGGpMvp2pg. | Posted resource/time-attributable billing with usage cutoff/lag/tax/credits/scope. Aggregate account estimates and public calculator cannot establish incremental backup cost or remaining allowance. Unreconciled. |
| A12-M06 | Embedded acceptance for A12-002/A12-004; no competing paging code. | Owners must supply complete selected-window fixtures for stable continuation, repeated/expired tokens, partial failures, caps, duplicate pages/rows and exclusions. Accounting totals independent of top-N/run_limit; API/UI partial coverage explicit. Their unmerged branch tests have not been verified here. |
| A12-O01 | Conservative assessment: no justified prompt/context change. Reuse Audit 10 evaluator at backend/app/domains/recommendation_audit/evaluation.py; no alternative quality policy. | Retained length/growth/repeated-evidence metadata, identical source coverage and financial safeguard gates, comparable outcomes and retry-inclusive costs. No private prompt extraction, reduction, paid A/B or realized saving claim. |
| A12-O02 | Conservative assessment: currently selected model preserved. No justified model-mix change. | Comparable saved quality, formatting, reliability and total retry/tool/search-inclusive costs through Audit 10/11 owners. Nominal tariff differences cannot establish billed savings or a certified ceiling. |
| A12-O03 | Offline reuse eligibility review fixture checks owner/evidence digest/data cutoff/schema/model, explicit expiry and independent sampling. Never authorizes live reuse. | Audit 9 isolation and Audit 10 freshness/sample-independence review; explicit invalidation contract and measured comparable benefit. Accounting response dedupe remains separate from new-run result reuse. No deployed cache or suppressed evaluations. |
| A12-O04 | Acceptance retained with existing backup owner and A12-006 estimator owner. | Private retention/dependency inventory and explicit owner-approved removable capacity. No approved removable backup established. Required backup cannot be labelled savings. No deletion/resize/retention changes. |
| A12-O05 | No justified sizing change; existing sole operator remains evidence owner. This is separate from cost/output-provenance task 6hhg5hVHmrVFjC28. | Current identified workload/window and queue/CPU/RSS series tied to M01/M02, reliability, resource-attributed cost and rollback. Historical CPU credits/free-memory snapshot insufficient. No provisioning or savings claim. |

## Reproduce safe checks

From repository root:

```
python -m unittest discover -s scripts/offline_evidence -v
node --test scripts/offline_evidence/candidate-budget.test.mjs scripts/check-javascript-budgets.test.mjs
```

For an already retained, safe current candidate report:

```
node scripts/offline_evidence/candidate-budget.mjs performance-results/javascript-budget-baseline.json /path/to/candidate.json EXPECTED_40_CHARACTER_SOURCE_SHA
```

The adapter performs local reads only. It does not invoke the performance collector,
authenticate, start a browser, create traffic or fetch measurements. Keep private
input files outside tracked paths. Helpers return aggregates and reasons; callers
must not publish owner identities or private timestamps. Twenty valid samples is
only a small-sample reporting guard, not independence proof or an SLA standard.
Repeated comparable evidence and explicit exclusions remain required.

Any remaining live read plan belongs with the coordinator: identify exact existing
trace/metric sources, owner-safe fields, source SHA, bounded window/sample count and
read-only scope before execution. No provider/billing collection, traffic replay,
load test, policy change or host action is authorized by these helpers. Underlying
findings remain open until their evidence and review gates pass.
