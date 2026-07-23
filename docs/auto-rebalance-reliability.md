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

## Operating guidance

Use the clock beside either dashboard auto-rebalance title to inspect all runs.
The newest tile summarizes progress; its detail view shows stage status, raw
prompts/output, provider-level token/cost data, and errors. A red stage means
the sequence stopped safely and needs an input/provider correction before a
new run is started.
