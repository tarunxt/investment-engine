# Auto-Rebalance Reliability and Run History

## Why a sequence could stop mid-run

The dashboard coordinates the handoff between independently queued Celery
stages. Each handoff used to depend on a normal API read with an 8-second
timeout. A slow API proxy, temporary network loss, dashboard refresh, or an
expired session could therefore be displayed as a stage failure even while the
Celery worker had already completed and saved the underlying AI job.

The old fallback also allowed a later trading stage to use a previous saved
output after a failure. That made the stop difficult to diagnose and could mix
fresh portfolio data with stale analysis.

## Current guarantees

- Read-only API calls have a 20-second timeout and bounded exponential retry
  for timeouts, network failures, rate limits, and 5xx responses. The
  auto-rebalance handoff reads then continue retrying transient failures until
  they succeed or the user cancels the flow.
- Polling remains active until a persisted AI job reaches a terminal state.
- Every auto-rebalance now has a durable parent workflow and one durable record
  per stage: sync, threats, swing, rebalance, technical, and actionables.
- Concurrent, delayed browser audit updates are serialized and cannot regress
  a terminal stage back to `processing`. A child run/job must also belong to
  the same user, portfolio, and sequence before it can be attached to a stage.
- A genuine stage failure is terminal for that sequence. It is never silently
  replaced by a prior saved output; the precise stage, child run/job, model,
  provider, cost, and error remain available in history.
- If a tab is reloaded or closed between stages, the completed worker result is
  retained and the first unlaunched stage is marked `interrupted`. The system
  intentionally does not launch a later trading stage from an abandoned browser
  session, because its selected inputs may no longer be current. Paused and
  cancelled flows are likewise explicit terminal audit states.
- The history API merges new durable workflow records with legacy labelled
  runs/jobs, so runs completed before this change remain visible.
- Stage handoffs include each authenticated source once, using market/stage plus
  run/job identity for Swing and Rebalance outputs, and the market-specific threat
  job identity for Threat outputs. Identity sets exist only for the current
  handoff. A generated output selected again or returned by the latest-run fallback
  does not add another copy to the next model prompt.
- Distinct jobs remain independent evidence, including repeated samples from the
  same provider/model, identical stock candidates, rationale and dissent. First-seen
  source order is retained; content rows are never deduplicated by normalized text.
  PR1213's market/stage classification and display-consensus identity checks remain
  in place. Model choices, sample counts and all six workflow stages are unchanged.
- Explicitly selected historical run/job and threat-job IDs are fetched through
  authenticated detail endpoints. Missing, invalid, cross-market or wrong-stage
  selections stop the handoff before the next paid request, rather than silently
  replacing them with a recent result. Threat market/stage ownership is checked by
  the corresponding server endpoint; the client also checks the returned job ID.
- Two deliveries of one source must have identical response text and source
  provenance. The API has no dedicated response-version field, so exact text
  comparison detects conflicting output versions without lossy normalization or
  hash collisions. Export-only timestamps may differ. Conflicts produce an
  actionable request to refresh Select Inputs and start a new workflow.
- The manual Rebalance Console catches the same validation errors in its input
  preview and blocks form submission until inputs are valid. Refresh and selection
  controls remain available, and unrelated Create Job forms keep their existing
  behavior.

## Offline verification

From `frontend/`, run:

```sh
node --test tests/rebalance-stage-inputs.test.mjs tests/final-actionables-run-identity.test.mjs tests/rebalance-workflow-resilience.test.mjs
```

This exercises the pure
identity helpers and the real workflow callback with mocked APIs only. It checks
generated/selected overlap, historical selections, independent same-model samples,
source conflicts, market/stage rejection, evidence order, failure before queueing,
unchanged six-stage execution and sample counts, and the manual form's submit
guard. No provider, scan, trade or
production endpoint is contacted by these tests.

## Operating guidance

Use the clock beside either dashboard auto-rebalance title to inspect all runs.
The newest tile summarizes progress; its detail view shows stage status, raw
prompts/output, provider-level token/cost data, and errors. A red stage means
the sequence stopped safely and needs an input/provider correction before a
new run is started.
