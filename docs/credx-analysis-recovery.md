# Equity analysis-only recovery

This opt-in mode contains execution during disk/storage recovery without changing
credentials, permissions, schemas, historical records or the normal application
behavior. Enable it only in a new API/analysis process with `CREDX_RECOVERY_MODE=1`.
Absent mode means normal behavior; explicit `0` also retains normal behavior.
Invalid values refuse startup/execution. Mode changes require fresh processes.

## Boundaries

The API admits login, INDmoney holdings/prices/events/threats and Zerodha portfolio analysis, prompts/providers,
usage data and run/job result paths. Zerodha login, connection status and portfolio snapshots
are also admitted; callback and manual sync may enqueue only the portfolio-read task. Transaction/bot endpoints, cancellation,
backfill, external-export requests and websocket handlers are unavailable.
Run creation requires `auto_rebalance_portfolio=indmoney_us` or `india`, and
either no context or matching US/India `equity_output_sources_v1` context.
Zerodha threats/events reads and run endpoints are admitted so India threats,
swing, rebalance, technical and final-actionable stages can complete. Worker execution checks this identity
before registration/status changes; generic or Polymarket jobs are refused.
The existing UI may request a sheet export; recovery disables that optional
export, retains database results, and suppresses completion mail publication.

No Polymarket bot can initialize/start in recovery. Bullpen runtime commands are
blocked before classification and at the subprocess boundary, including reads,
unknown verbs and auth refresh. Direct CLOB submission and non-read RPC calls,
and non-read Zerodha HTTP calls other than the exact login token exchange
(`POST /session/token`), are blocked before clients/network submission.
This also contains forced redeem/claim paths that bypass LIVE_TRADING=false.

## Analysis queue isolation

Use only `credx_recovery_analysis`, with broker AND result prefix
`credx:recovery:analysis:v1:`. Only `app.domains.jobs.tasks.execute_ai_job` and
`app.domains.zerodha.tasks.sync_portfolio_snapshot_task` are published/executed; explicit old queue overrides are rewritten. Publication
refuses missing/mismatched isolation settings. Redis/rediss are required because
that transport implements reservation-key isolation. Missing queues cannot be
created, remote control is disabled, startup recovery/index hooks return before
queue/Redis mutation, and the beat schedule is empty. Existing financial workers
and the scheduler must remain stopped.

The prefix isolates Celery queues, bindings, unacked hashes/indexes/mutexes and
result keys. It does **not** claim to isolate ordinary application cache, locking,
job registration, status publication or database keys. No legacy broker message
is migrated, acknowledged, restored, purged or requeued by this implementation.

## Review and activation prerequisites

Before any production process is started, verify candidate/file checksums and
rollback, recovery mode on both producer and consumer, exact queue/prefix
configuration, empty new namespace and continued stopped financial services.
Normal financial service installation and restart must not run. The production
workflow detects recovery mode and uses `deploy/no-docker/deploy-recovery.sh` to
verify isolation and restart only the contained API and recovery consumer. Do not use the old ai queue.
A proposed consumer must explicitly select the recovery queue and disable
mingle/gossip; do not launch beat, old queue consumers or a generic worker.
Production activation is a separate verified step; these instructions alone do
not establish that a complete browser/provider workflow has run.

## Validation

Run `backend/tests/test_recovery_containment.py` with existing dependencies. Tests
cover command/client submission rejection, no bot background initialization,
API lifespan/routes with isolated dependencies, producer identity/fanout,
startup hooks, allowlisting and Redis reservation/result namespace behavior.
The reservation test runs real Kombu QoS.restore_visible and Redis lock code with
only socket I/O replaced; it proves legacy visibility exclusion, not real Redis
consumption/ack/redelivery. Fanout tests replace database/provider/network work;
they do not claim a complete six-stage browser/LLM run. Existing runtime broker,
direct execution, bot-start, worker queue and V3 storage regressions should also
pass with mode disabled. No production financial call is a validation step.
