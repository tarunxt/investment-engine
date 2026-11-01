# REBALANCE-WORKFLOW-F02

Revalidated against da317a1097cef97089e3a745b9e20b4952af6a48. Rebalance inputs omit
stored margin/wallet values. The additive `rebalance-funds/v1` contract now includes
the exact snapshot field, currency, captured timestamp and value in the portfolio
section. Both full model inputs and summary previews use the shared bundle. New
saved prompts retain this version and evidence; historical prompts are untouched.

India `available_margin` is persisted from the normalized broker response, but
normalization and schema defaults can replace absent data with zero. Its source
completeness cannot be reconstructed from the snapshot. The contract exposes this
limit and never labels it cash. US `wallet_balance` is the captured parsed wallet
value, not buying power. Missing/nonfinite/malformed values stay unknown; negative
and zero numeric values are retained. No live refresh or freshness threshold is
introduced.

No deployable-budget policy has been established. This patch exposes funds evidence
and explicitly leaves funded sizing unverified; it does not change Swing capital,
allocations, affordability, order safeguards or India Threat prompts (cash remains
unknown there). A policy defining usable funds and live reconciliation remains an
owner dependency. This is a partial remediation, not proof of funded model sizing.

Acceptance uses synthetic fixtures only. No providers, broker refresh, trades,
exports or production operations were invoked. The supplied PDF could not be
materialized: both initial and bounded executor-local retry returned NOT_FOUND
(Library file not found); source inspection uses the exact delegated finding text.

Verification: five combined deterministic frontend suites passed (89 tests),
including actual workflow functions for interruption, repetition, snapshot drift,
partial output and audit persistence. New tests cover both preview modes and
missing, zero, negative, fractional, invalid and stale captured funds. Audit capture
already stores the full prompt with a hash when within its existing size limit;
above that limit existing `prompt_size_exceeded` coverage applies. No audit schema
or historical evidence was rewritten. Live UI acceptance and live model-versus-funds reconciliation remain unverified.


Follow-up browser acceptance: `node scripts/rebalance-funds-offline-playwright.mjs`
from `frontend` passed 15 synthetic Chromium cases. The fixture compiles unchanged
production RebalanceInputBox declarations, real readiness and UI components; only
API/dashboard context and the CreateJobCard submission boundary are synthetic.
It checks exact source field/currency/value, stale timestamp, margin zero provenance,
wallet versus buying power, unknown values and budget caveats in the actual rendered
Portfolio section, combined-context detail textarea, generated prompt and retained
source-selection bundle. Refresh and collapse/reopen retain the evidence; snapshot
read errors leave prompt/selection empty. Zero external requests and provider calls.
There is no funds-specific popup in this input component. Live execution acceptance
is not implied. TypeScript checking also passed for the implementation.

Exact remaining policy question: Which funds source and rule should define each
market's deployable rebalance budget? This is required only for funded-sizing
enforcement beyond truthful source context. Existing Swing ideation capital remains
unchanged.
