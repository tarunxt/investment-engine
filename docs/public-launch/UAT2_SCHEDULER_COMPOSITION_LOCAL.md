# UAT2 scheduler composition: local candidate, no native activation

## Defect and scope

The owner acceptance report found an existing queued analysis workflow with a
due unpublished outbox event, no publish/execute attempts, empty dedicated Redis
queues and an active worker. Source inspection confirms the native worker unit
starts a Celery consumer without Beat, although `app.uat2.worker` registers three
Beat entries. There is no native Beat unit. Previous disposable qualification
manually published relays and therefore did not establish automatic scheduling.
Earlier green CI remains valid for its restricted checks, not scheduler liveness.

The local branch was isolated from reviewed `ea64cc3` at 07:58:09 UTC on
2026-10-24; inspection preceded isolation. The exact first inspection timestamp
was not retained. Existing generated frontend directories were preserved.
No deployed workflow was delivered, resubmitted or modified by this work.

## Selected design and alternatives

`python -m app.uat2.runtime` is a new explicit worker launcher with fixed arguments
for the existing four dedicated queues, concurrency one, prefetch one and the
existing child-task cap. It embeds Celery Beat as a child of the same worker
service, using `SimulationScheduler`. It accepts no CLI overrides. Startup keeps
the existing owner-only UAT2 environment, simulation and dedicated transport
validation. This does not replace the current native unit command automatically.

The scheduler permits exactly these already registered, argument-free controls:

| Control | Interval | Queue | Expiry |
| --- | ---: | --- | ---: |
| `uat2.analysis.relay.v1` | 5 seconds | `uat2_simulation` | 5 seconds |
| `uat2.orders.relay.v1` | 5 seconds | `uat2_simulation` | 5 seconds |
| `uat2.operations.observe.v1` | 60 seconds | `uat2_simulation` | 30 seconds |

Unknown/missing/changed schedules, task arguments, queues and unregistered tasks
fail closed. Dispatch revalidates the entry. There is no arbitrary `send_task`
fallback, default cleanup entry, persistent Beat file or catch-up replay. Restart
begins fresh intervals; PostgreSQL outboxes remain the durable work authority.
Dedicated publication retry is disabled and Redis socket/connect timeouts are
bounded to three seconds; a later tick recovers eligible durable messages.

The existing relays keep their limits and execution guards: analysis publishes
at most two stages and two governed jobs per call; orders selects at most two
preparations, two approved events and two reconciliation candidates. Current
owner/module/provenance checks remain in consumers. Beat cannot approve a basket,
create a new analysis request, grant a role, send an external alert or call a real
broker. Monitoring uses the existing internal synthetic sink.

A separate Beat service would require a ninth service and additional lifecycle
coordination. A persistent scheduler would also require an approved writable
state path. Neither is selected. The embedded in-memory option adds one child
process inside the existing worker cgroup and confinement, with no new service,
port, credential, allowlist, writable directory or infrastructure resource.
Its actual memory/process budget still requires disposable Linux qualification.

## Qualification and review

- Final focused run: 37 passed, zero skips, covering 11 scheduler cases, seven
  existing analysis-worker cases, 13 native order/bootstrap cases and six source
  baselines. The bootstrap check invokes the actual launcher with only
  `worker_main` intercepted, and checks fixed Beat arguments and transport bounds.
- Existing native policy/runtime/Google/static-route regression command: 54
  passed, zero skips. These are local application/guard checks, not PostgreSQL or
  packaged Linux execution. No frontend product code changed.
- A real Celery Beat Service loop automatically dispatches only the three controls
  without creating a schedule file or replaying missed ticks. A separate real
  solo Celery worker uses Kombu memory transport and disposable SQLite, survives
  a consumer/scheduler restart and completes durable work. Duplicate stage
  deliveries and uncertain publish acknowledgements do not repeat execution.
  Unapproved orders remain unapproved; no approval event is created.
- The first no-file assertion incorrectly included pre-existing fixture SQLite
  files and failed twice (one already-running collection retained the old test).
  It was corrected to inspect only a dedicated scheduler-state directory. Both
  failed attempts remain in local evidence; they are not product runtime passes.
- Independent review found a restart-proof race in the initial probe revision.
  The disposable test now stops the consumer and Beat, requires exactly one owned
  intent to remain unknown while stopped, then starts the worker and checks
  reconciliation. It fails if reconciliation wins the stop race, rather than
  claiming uncertainty survived restart. Follow-up inspection found no further
  concrete issue.
- The disposable Docker launcher now uses `app.uat2.runtime`. The HTTP probe has
  no direct relay/task publication; analysis, fake execution, reconciliation and
  monitoring must be driven by the scheduler. Both simulated Kite modes and an
  accepted US import remain covered, with immutable one-attempt/one-receipt
  checks. These revised Docker/PostgreSQL/Redis checks have not run locally:
  Docker, PostgreSQL and Redis server executables are unavailable. They are wired
  into the existing native CI job and need exact-candidate publication approval.
- Source inventory is current with zero unresolved entries. It observes 20
  scheduler registration sites (including this guarded schedule projection),
  rather than certifying 20 active runtime schedules.

## Material activation requirements

No native systemd unit, controller, compose command, preflight, environment,
security setting, retention setting or deployed service is changed. The current
native consumer-only launch remains in place. The disabled privacy contract
`82c008f` is unchanged. Real deletion and all real-provider effects stay disabled.

After separately approved publication and exact-candidate CI, native activation
would require review of this proposed replacement for the existing worker's
ExecStart only:

```
/opt/credx-uat2/current/.venv/bin/python -m app.uat2.runtime
```

The working directory, environment files, account, filesystem/network confinement,
service count and resource caps would remain as currently configured. Changing the
deployed unit/reloading/restarting it is a separate material runtime operation,
not authorized or performed here. Deployment ownership remains with the existing
deployment worker. Review must explicitly acknowledge that activation starts
processing already-due owned simulation work, including the preserved acceptance
workflow; no manual outbox delivery, workflow resubmission or approval replay is
needed. Monitor the original workflow, worker/Beat process health, queue/outbox
attempts and immutable fake receipts after activation. Production and live
provider access remain excluded. Hosted owner acceptance, complete privacy
coverage and production readiness are not established by these local checks.
