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
