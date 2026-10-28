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
