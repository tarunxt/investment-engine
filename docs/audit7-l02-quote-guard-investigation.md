# A7-L02 Technical quote guard investigation

Revalidated against main `da317a1097cef97089e3a745b9e20b4952af6a48`.
Classification remains **blocked guard, not confirmed defect**. No production
behavior, thresholds, source mapping, permissions, or saved records were changed.

## Verified source contract

`frontend/lib/technicalPriceEvidence.ts` requires exactly one quote matching each
requested `exchange:symbol` string. Missing, duplicate, and different-venue
records fail before price validation. Positive finite prices and parseable
timestamps must have an age between -60,000 and 900,000 milliseconds inclusive,
using the frontend clock captured at the start of `resolveTechnicalPriceEvidence`
(before the quote read). Invalid price, invalid timestamp, too-old timestamp, and
excessive future skew share the reported invalid/stale message. That message
alone cannot establish which predicate failed.

The India Technical path in `RebalanceWorkflowSections.tsx` awaits this resolver
before calling `apiService.createRun`. A thrown quote rejection therefore precedes
the Technical run creation call in this path. This is source inspection, not a
replay or verification of the historical no-job outcome.

`backend/app/domains/zerodha/display_quotes.py` labels valid Kite prices with server
receipt time, not exchange trade time. Missing Kite prices may use exact-venue
Upstox fallback records. `upstox_quotes.py` preserves exchange last-trade timestamps
and labels older trades explicitly, including retrieval time in source text.
Consequently a newly retrieved display quote can correctly fail Technical age
validation. These are different timestamp semantics; neither establishes which
source served the historical failed attempt. No source or mapping defect is demonstrated.

The pre-existing resolver separately permits explicitly unanchored research for
a specific market-data entitlement 403. Invalid/stale successful quotes do not
enter that branch. This investigation does not expand that policy.

## Evidence and acceptance limits

The original quote payload,
source, price, as-of timestamp, exact validation clock and provider-job history
were not available in this environment. No production read, quote request, broker
refresh, provider execution, or settings change was performed. Whether that
specific rejection was correct remains unresolved.

Original attachment bytes were unavailable locally. No attachment hash or pixels
were verified. This investigation records source inspection and synthetic test
coverage only; private report observations are excluded from this repository.

Synthetic tests protect inclusive freshness boundaries, excessive future skew,
missing/invalid timestamps, zero/negative/non-finite prices, partial batches,
repeated failure, later valid input, exact anchor preservation, and non-mutation.
Existing tests cover different venues, duplicates, stale quotes and unrelated
transport/authentication errors. They do not prove production acceptance or
downstream frozen Actionables acceptance. No UI change was made; no browser
acceptance is claimed.

Verification: `node --test tests/technical-price-evidence.test.mjs
tests/auto-rebalance-audit-persistence.test.mjs` passes all 49 tests. The extracted
actual workflow callback fixture also verifies stale quotes create no Technical
job, persist a failed Technical stage, withhold completed Actionables, and send no
completion email. This is not an actual browser fixture. `git diff --check` passes.
Backend baseline verification could not run: the default Python lacks pytest;
an isolated temporary pytest environment reaches eight setup errors because
the repository-wide telemetry fixture imports unavailable FastAPI dependencies.
No backend test assertion failure was observed. Initial frontend dependency
installation failed on an unwritable default npm cache; retry using a temporary
cache succeeded without changing tracked dependency files.

Next required evidence is an authorized read-only export of the original quote
record and workflow/job history, with original IDs and timestamp semantics
retained. Establish the failed predicate before considering remediation. An
authorized later valid-quote acceptance run remains outstanding; do not weaken
the guard, rewrite historical outcomes, or manufacture replacement user data.
