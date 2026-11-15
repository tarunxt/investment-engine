# Auto-rebalance completion evidence

Worker outputs and workflow audit persistence are separate facts. A completed
model job remains readable if a browser loses its audit response. The UI keeps
those outputs available and reports pending or unconfirmed history separately;
it never regenerates paid work to repair metadata.

New stage rows initialize their status explicitly and join the loaded workflow
relationship before serialization. Parent-row locking and refreshed relationship
loads serialize concurrent first writes. Terminal stage status, timing, errors,
progress and confirmed execution links cannot be replaced by delayed callbacks.
Missing metadata may be enriched without changing an established outcome.

LLM stages marked completed or partial require matching owner, portfolio,
sequence, semantic stage and persisted execution evidence. A Run/Job pair must
represent the actual membership. Non-LLM and skipped stages have explicit
separate semantics. The parent reaches a successful terminal state only when all
six durable slots have successful or skipped outcomes; partial work remains
partial. Earlier updates cannot move its active stage backwards.

The frontend captures the exact portfolio and sequence in each metadata queue.
It waits for audit acknowledgements and matching saved history before requesting
an overall completion email. Lost responses can reconcile against persisted
facts. Exhausted writes or reads leave a visible warning; reopening a page does
not pretend an ephemeral request is still running. Pause/cancel boundaries and
new-run identity guards keep old callbacks from changing later work.

Completion emails validate durable workflow/execution evidence. Overall email
requests create a transactionally stored completion event and use the existing
outbox/recovery worker, template and preferences. A broker enqueue failure does
not discard that durable event. Historical Redis claims are honored because
past delivery is ambiguous. This is not an exactly-once SMTP guarantee.

Existing workflow rows report their durable lifecycle rather than deriving a
successful parent from a subset of completed child outputs. Legacy history
without a durable workflow retains its compatibility projection. This change
neither backfills old audit rows nor modifies saved model responses or financial
strategy. A historical incomplete audit can therefore block a success-email
request even when its completed outputs are still accessible.

## Verification

- Real async SQLite route tests cover first writes, serialization, idempotency,
  delayed state/metadata, ownership and execution evidence, and notification
  recovery with mocked dispatch.
- Guarded PostgreSQL tests exercise concurrent first-stage writes, delayed
  retries and simultaneous overall-email requests. They require an explicitly
  disposable localhost test database and create only their own random schema.
  The CI job supplies that database; a local skip is not runtime verification.
- Frontend behavioral tests execute the real callbacks and workflow with fake
  APIs. They preserve the existing model targets, prompts, independent samples,
  output availability and explicit user controls.
- The recommendation renderer identifies Rebalance from its position/action
  columns. Shared stock/price fields no longer misclassify the 31-column Swing
  schema as the 29-column Rebalance schema.


## Historical score evidence reader

`GET /runs/recommendation-audit/historical-score` reads the authenticated owner's
exact run, market, symbol, exchange and historical timestamp. An optional history
ID must match the same selection. It reuses retained immutable decision/input
captures and per-job source samples, independently of raw Run/Job retention.
Multiple matching revisions return ambiguity rather than selecting the newest.
Existing audit enablement and authentication remain required.

New terminal captures include an additive `stored-score-matrix-v1` snapshot in
the existing decision JSON. Recorded calculations and original formula inputs
are copied; the reader never calls the current scoring algorithm. Older captures
can expose the same recorded values without a database migration. Missing rule
annotations, means or original formulas remain explicitly unavailable.

Legacy history snapshots may already retain original per-job parameter cells in
`snapshot_json.rows[].raw`. These can populate parameter scores/rationales even
when the original weighted matrix is absent. Duplicate rows for one job are
ambiguous and excluded; independent jobs remain separate. The saved legacy score
and action are preserved. No current settings or latest stock data substitute
for missing evidence.

Before any proposed historical backfill, run the read-only coverage reporter in
an authorized runtime with a verified owner ID:

```sh
PYTHONPATH=backend python backend/scripts/report_historical_score_coverage.py \
  --user-id VERIFIED_OWNER_ID --market india --symbol HAL --day 2026-10-05 \
  --timezone Asia/Kolkata
```

It reports metadata and ambiguity only, rolls back, and has no apply mode. No
production coverage is implied by synthetic tests. A missing original formula
cannot be recovered from today's configuration or from parameter cells alone.


## Stock history chronology and displayed actions

Captured Stock Details combines original saved summaries, explicitly labeled
current-formula reconstructions, and all retained owned run/model observations.
Source observation reads scan keyset pages from retained RunJob/Job records and
immutable output captures, without queuing materialization or rerunning providers.
A stable run/job/response revision/row identity deduplicates identical immutable
copies while preserving different models, revisions and rows. Failed/partial
sources retain their actual status. Unknown market identity and deleted uncaptured
outputs cannot be reconstructed. The UI reports partial reads and scan progress.
Saved summary reads follow every available page rather than requiring older-page
clicks; the merged chronology sorts newest first.

The score-based displayed action applies the existing matrix range evaluator to
the exact stored score, before rounding. It is labeled as current rules; original
recorded action, formula version, score, units and amounts remain unchanged.
A positive score needs known historical holdings to distinguish Add more from
Buy New. Current holdings never stand in for missing historical holdings. Missing,
nonfinite or out-of-range scores stay undetermined. These display actions do not
modify trading logic, executable orders, saved history or historical policy.

## Basket display calculations

Portfolio Parameters supplies local display inputs only. Executable orders,
selections, thresholds, quantity controls and payload builders do not consume
these derived weights or broker sizes. Ranking uses the full captured stock
universe, including Hold rows displayed without executable controls.

Historical Weighted Score is the arithmetic mean of every valid saved completed
run score in the rolling interval `(as_of − N × 24 hours, as_of]`, never daily
averages. The authenticated profile timezone is returned for presentation. Owner,
market, venue, completed-run identity and bounded scores are checked. Complete
immutable captured decisions can supply a recorded score absent from saved
summaries. Disagreeing complete captures are excluded rather than selecting the
latest. Missing venue, deleted/unknown run status and invalid scores are excluded.
A truncated read produces no allocation.

The denominator sums the top editable Maximum Stocks strictly positive scores.
Only those stocks receive weights; ties use canonical exchange:symbol order.
Weight is `MIN(score × (1 − cash/100) / denominator, normalisedMax/100)`, without
cap redistribution. Missing/zero denominator produces blank weights. Visibility
uses the current displayed Score, inclusive outer ranges, independently of the
ranking universe. Show all defaults on because the existing basket had no numeric
visibility filter; action eligibility and buy selection thresholds are separate.

Zerodha display stocks are `ROUND(weight × INR totalAssets / LTP, 0)` and amount
is stocks × LTP. IndMoney amount is `ROUND(weight × USD totalAssets, 0)` and stocks
are amount/LTP, allowing fractions. ROUND uses nearest integer with halves away
from zero. Total assets reuse selected portfolio value plus the same available
margin shown in Buy Basket. Missing funds remain unavailable, never inferred
from an inclusive wallet balance or treated as zero. Portfolio and quote source
timestamps remain separate. Popups expose contributing history, formulas, inputs
and intermediate values. No currency conversion or order placement occurs.


Basket review corrections: group checkboxes act only on visible selectable order
IDs; All Stocks retains its existing whole-basket semantics. Filtering itself does
not change selection, and hidden selected executable orders are disclosed. New
sizing displays use only a unique exact-venue positive broker last/market price
with its captured source timestamp, never purchase average, prior close or a
symbol-only lookup. An INDmoney snapshot without explicit venue cannot certify
share sizing; its USD amount calculation remains independent of LTP. Existing
executable pricing is unchanged. Reopening a basket clears the calculation
universe and snapshot before preparation; failed/cached-source preparation leaves
those calculations unavailable. Generation guards discard stale completions and
responses after dismissal.

## Workflow input lineage and final capture (workflow-final-v1)

The automated Rebalance handoff uses only its generated Swing output and jobs
explicitly selected in Select Inputs. An empty explicit selection never expands
into a market-close window or latest-run fallback. Technical uses the same rule.
A requested Next source that was not generated fails before another paid call.
Rebalance reuses its workflow portfolio snapshot and rejects a Threat report from
a different captured timestamp. Saved prompts identify each Swing run and job.
The Stock Flow header separately lists the actual saved Rebalance Swing inputs.

India holdings prompts include all records, settled and T1 units separately, and
use settled plus T1 for investment exposure. This does not authorize or increase
sellable order quantities. Historical saved prompts are never rewritten.
Technical attempts timestamped exact-venue broker quotes (at most 15 minutes old)
and rejects missing/ambiguous anchors. Opt-in worker validation requires every
listing exactly once and numeric trigger/invalidation prices within 25% of the
anchor. A different corporate-action price basis must be reconciled before a new
scan; no automatic scale correction or invented setup is applied.
A confirmed HTTP 403 Kite market-data PermissionException instead uses the existing
internet-research prompt, with TECHNICAL_PRICE_MODE_V1 recorded in the saved prompt.
No broker anchors are emitted in this mode and researched prices are not described
as broker-verified. Authentication/network errors and invalid returned quotes still
fail the stage. Input lineage and frozen final calculation checks are unchanged.

Mixed successful/failed provider jobs record a partial stage even when an older
aggregate Run status says completed. Listing counts are parsed by table headers,
not fixed column positions, and are no longer divided by an arbitrary target.
Output contract v2 sets model/run/time identity from runtime metadata while
retaining the original cells in normalization provenance.

Before Final Actionables completion, the exact final rows, excluded non-buy
listings, formula, per-row inputs, source run IDs and response hashes are frozen
in the existing durable stage summary as `frozen_final`. The backend verifies
owned terminal source revisions and technical workflow identity. Its first
terminal summary wins on retry; current-formula previews never rewrite it.
The workflow audit page exposes this saved snapshot. Old runs without a snapshot
remain explicitly unavailable; this release does not backfill historical scores.

## Missing Rebalance cells (output v3 / score matrix v2)

Rebalance preserves rows with unavailable non-identity fields as `-`; missing
numbers do not become zero. Named missing fields and explicit placeholders are
accepted with warnings; conflicting quantities, invalid numeric values, duplicate
identities and missing exchange/symbol still fail validation. Canonical irregular-width
rows with the first 17 typed fields present retain those fields. Because omitted
rationale cells cannot be located reliably, their entire uncertain suffix is
preserved in `Unaligned source cells (not scored)` and rationale fields become
`-`. Rows shorter than the typed prefix and tables with ambiguous headers are still rejected.
Over-wide rationale suffixes are preserved as unscored source cells too; typed
prefix validation must still pass.

Frontend weighted scores and new recommendation audit calculations exclude missing
samples from averages and missing components from numerator/denominator. Explicit
zero remains a valid observation. Formula overrides remove unavailable weights;
the editor operates on its displayed effective denominator. New calculations carry
`missing-score-exclusion-v2`; final matrix captures include `calculationPolicy: missing-score-exclusion-v2`
while retaining the compatible `score-matrix-v1` envelope.
Existing immutable history and terminal job statuses are not rewritten.

## Partial LLM usage classification

Accepted Rebalance outputs with missing or unaligned values finish as `partial`,
with a partial-use notice and `deterministic_output.usage_status`. Completed counts
include terminal attempts; Passed, Partial and Failed are separate counts in stage
tiles and saved summaries (`partial_llms`). History APIs expose an additive
`partial_provider_count`. Partial notices are amber and do not open failure dialogs.

Legacy invalid-contract failures are recovered only when the current normalizer
can validate the complete output against the saved holdings and input identities.
Job response DTOs expose canonical partial output; ORM jobs, original errors and
frozen workflow snapshots are unchanged. Original failure details remain under
`partial_recovery` metadata. Stage read summaries use the projected counts. Genuine
provider failures, contradictions and unparseable outputs remain failed.

### Usable partial sources in basket history

Basket display history accepts a finite saved stock score from a completed or
partial run. The additive `eligible` flag is distinct from `completed`; partial
runs retain their actual status. Current basket calculations also accept partial
source runs, retain the server-observed timestamp and exact market/venue checks,
and suppress overlapping saved observations so each source contributes once.
Failed/pending sources, invalid scores and unknown identities remain excluded.
Immutable audit fallbacks still require their original complete formula evidence.

The stock popup merges retained recent run reconstructions into the summary-source
table, ordered newest first, without writing history. An original saved summary
wins over its reconstruction; gap records do not hide usable retained output.
Reconstructed scores have a separate column and are never relabelled as original
recorded scores or substituted into the saved-score average. Historic rows without
an original saved overall score cannot retroactively provide one.

### Stock Flow listing coverage and saved Swing sources

Stock Flow retains every exchange/symbol from the Rebalance universe in Final Actionables. Formula decisions retain their existing eligibility rules. Listings excluded from that calculation remain visible as No trade (all available model actions are Hold) or Not actionable, with recorded reasons and a missing score. Display-only rows never become basket orders or allocations. Counts distinguish formula decisions from retained non-executable coverage, and venues remain separate.

The Swing tile groups the exact selected job responses embedded in the saved Rebalance prompt by Swing run, with the saved Created timestamp and newest run first. This includes historical inputs outside the recent-run fetch window without substituting newer responses or unselected jobs. Historical prompts, outputs, and frozen final artifacts are unchanged.

### All analysed listings receive their calculated scores

Final Actionables and the basket allocation universe now retain zero-position Hold/non-buy decisions and calculate their scores through the same score matrix as the Actionables layout. Scores are not hard-coded or replaced with missing placeholders merely because no trade was proposed. The basket separately excludes explicit all-model zero-position non-buy decisions from executable orders, while displaying them in the full allocation universe. Missing-analysis-only rows still do not acquire invented scores. ZerodhaStocks and Zerodha Amount cells omit the inline Estimate suffix; price-source information remains available in their tooltip and calculation popup.

### Basket target versus current allocation

Final Weight is now labelled Target Weight. The India basket adds Current Weight, Difference, and Action New. Current Weight uses each exact exchange/symbol holding’s settled plus T1 quantity times its saved LTP, divided by the sum of those holding values plus available margin. Non-held listings are zero only with a complete valid portfolio snapshot. Missing values or a non-positive denominator remain unavailable. The same T1-inclusive asset base is used for India display sizing.

Difference is target minus current weight in percentage points, coloured green/red by sign. Known scores outside the positive-score allocation set have target zero; missing scores never imply zero. Action New prioritises Sell All for held stocks with zero target, otherwise Buy New/Add More for positive differences, Trim for negative differences, and Hold for equality. This comparison is display-only and does not change existing order eligibility, selections, quantities, or historical artifacts.

### Display action sizing in the India basket

Action Zerodha Stocks and Action Zerodha Amount appear before the renamed Target
Zerodha Stocks/Amount. These are display calculations, separate from executable
Units, Amount, selections and broker payloads. Signed shares use (current portfolio
value + available margin) × (target weight − current weight as a fraction) / genuine
Upstox LTP, rounded to nearest whole share with halves away from zero. Sells are
capped at floor of the known exact-venue holdings. Zero target explicitly displays
all known holdings as a negative Sell All quantity, retaining a fractional display
holding total; it does not assert sellability. Amount is signed shares × Upstox LTP.
Missing Upstox price/provenance/time never falls back to Kite or a limit estimate;
a known zero-target quantity can still display while its amount is unavailable.
The stacked calculation view records the inputs, source/as-of, raw result and
rounding/cap. No stored audit snapshot, order sizing formula or historical artifact
is changed. Requested explanatory banners are removed without changing their
underlying market-access, score-selection, funding-buffer or execution safeguards.

### Offline basket checklist acceptance and tab-session column visibility

`npm run test:basket-offline` bundles the actual display hooks, portfolio parameter
controls, column picker and stacked calculation components with the production
preference wrapper into an isolated component fixture. It uses a dummy user,
fixed holdings/history/prices, a loopback-only fixture API and browser routing
that blocks external requests. This is offline component/browser evidence, not
production acceptance or a live-provider quote test. The surrounding basket shell
and executable sentinel are fixtures; existing order-handler and payload tests
remain the evidence for executable behavior.

Checks cover settled plus T1 portfolio value with margin added once, positive-only
top-N and deterministic ties, all three percentage steppers with 0/100 boundaries,
stacked Action/Target summary/details/close behavior, trim and zero-target
all-holdings quantities, and unavailable Upstox amount without a genuine fixture
price. Counters assert one fixture quote read per open/reload and none from local
control edits. Full page reload previously lost hidden columns; visibility now
uses tab-session storage scoped by authenticated user, broker and market. Storage
failures/corrupt entries fall back to usable in-memory defaults. No credential,
portfolio value or order data is written to these preferences; no backend schema,
order formula, frozen audit snapshot or executable payload is changed.

### Basket layout and Action New presentation

The India basket groups executable and display-only rows by calculated Action New,
independently of original Action or Side. Rows without an available derived action
stay in an Unavailable section. Moving a display-only row into a sell group never
makes it selectable. Group toggles operate on the current group's explicit guarded
order IDs, retaining hidden selections.

Units now displays the exact signed Action Zerodha Stocks value and opens that
same calculation. It does not silently rewrite executable order drafts or sides.
The basket submit controls fail closed if any selected row's displayed action
quantity/side differs from its executable draft; the reason is visible. Existing
whole-share, price, score, broker and recovery guards remain. This is a UI
consistency guard, not a new backend execution or sizing algorithm. Zero Target
Weight makes both Target Stocks and Target Amount zero even with known holdings
and no price; current holdings and sell-all Action quantities remain distinct.
Action/Target Amount presentation rounds to nearest integer (halves away from
zero), while formulas and detail values retain precision. After sales retains the
computed margin + selected sells − funding buffer amount.

Column configuration v2 stores canonical IDs, order, hidden IDs and display names
within the existing authenticated owner/broker/market tab-session scope. V1 hidden
preferences migrate. Native drag/drop, move buttons/Alt+arrow keyboard controls,
and right-click/keyboard context rename work without changing calculation IDs.
Rename cancellation/empty text never changes a name. Reordering transforms every
header/body cell together, retains selection controls and keeps the trailing
column-menu control reachable. Offline browser fixtures validate these controls
with blocked external requests; they are not production quote/order acceptance.

### Editable full-universe Market drafts

This supersedes the earlier read-only Units mirror and display-only selection UI.
Every captured India listing is visible and selectable, independently of score
ranges, Buy Threshold, validity or original executable status. Top-N/Target Weight
allocation math is retained. No automatic Buy Threshold selection remains in the
basket, and the obsolete threshold/range tile and selected/display-only count
copy are removed. Column identity/order/name persistence is unchanged.

Each row creates a draft from the absolute Action quantity suggestion. User whole
share steps are retained in component state through ordinary rerenders, allocation
updates and popup open/close; a fresh basket/snapshot scope begins a new draft.
Sell direction comes from Action New and is displayed with a red Units container;
buys are green, Hold/unknown is neutral. The Action popup distinguishes the signed
suggestion, positive edited Units, manual delta and edited amount. Amount always
uses current draft Units × genuine Upstox LTP; missing prices are unavailable,
including for zero Units, and no Limit/Kite estimate is substituted. Every India
row displays Market; Market has no limit-price field. Clickable numeric details
use hover/focus styling instead of dotted underlines.

Selection is not execution eligibility. The complete reviewed draft list reaches
the submission boundary; missing selected IDs are errors rather than silently
omitted rows. Both UI and submission guards report row-specific invalid/zero or
fractional quantities, missing/stale/future Upstox trade timestamps, unsupported
venues, Action/side mismatch, unknown/insufficient holdings and one-share Trim
review. Actual Market submission additionally requires regular market hours,
direct broker entitlement, existing whole-share review, account/broker validation,
and the existing explicit confirmation. Market drafts never silently fall back
to LIMIT trays. No broker API, credential, server validation or frozen historical
artifact is altered. Offline tests stop before any order or provider operation.

## Saved-output access (AUTO-OUTPUT-ACCESS)

Stage output dialogs render authenticated saved data directly. Console pages retain
`frame-ancestors 'none'`; they must never be embedded in a stage-output iframe.
Threats & Guardrails reads the selected portfolio's existing latest-analysis GET,
shows its saved job ID, provider/model, status and updated/created timestamp, and
renders saved Markdown as escaped text (structured reports fall back to JSON).
Sync reads the existing portfolio overview and shows only its latest saved snapshot.
A successful null result is explicitly empty; request and saved-job failures remain
errors with a retry. Retry reads saved data and never starts a workflow or provider.
The ordinary stage-page link opens in a separate tab with `noopener noreferrer`.

Each opening/retry invalidates earlier requests; closing also invalidates pending
responses. Historical run openings and retries retain the requested run ID and
portfolio/stage filters. The dialog supports Escape, keyboard focus cycling,
background inertness and focus restoration. Offline browser acceptance is available
with `node frontend/scripts/saved-output-offline-playwright.mjs`; it uses fixtures
and blocks external network requests.

## Per-run notification and export opt-out (REBALANCE-WORKFLOW-F08)

New workflow reservations accept `side_effect_policy` with exactly
`{"version": 1, "mode": "analysis_only"}` (or `existing_preferences`). The
nullable policy is frozen on the workflow, returned in reservation/history APIs,
and never changed by stage summaries or browser retries. Omission and historical
NULL retain existing normal-mode preferences. No stored user settings are changed.

The run checkbox suppresses notification outbox creation for every stage and
completion, disables automatic child-run export before provider/profile lookup,
and blocks both job/run Sheets workers before credential handling, including
repeated queued requests. Recovery containment remains independently effective.
The opt-out covers notifications and Sheets exports; existing analysis, portfolio
sync, broker permissions, order safeguards and costs retain their own contracts.
The browser refuses to start an opted-out workflow unless reservation confirms
the exact versioned policy, including during a mixed-version rollout. The checkbox
resets for a subsequent run; history retains the saved policy after interruption.

Deployment requires migration `audit7_run_policy_001` before the backend rollout;
no historical rows are backfilled. Local verification does not apply migrations
or establish live delivery/export acceptance. Offline component acceptance:
`cd frontend && node scripts/rebalance-policy-offline-playwright.mjs`.

Migration tests record upgrade/rollback operations and compile the PostgreSQL
column declaration offline; they do not prove a live database upgrade. Rollback
removes the saved policy, so production rollback requires stopping opted-out
workflows and their queued exports before downgrading.
