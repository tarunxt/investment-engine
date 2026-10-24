# Local repair from hosted owner acceptance

Successor to preserved82c008f1d6f23616cf1a04e28256b3db4e51e959. This local work
began2026-10-24 07:16:37 UTC. No push or deployment occurred. No hosted config,
auth/role, preference, import, source or financial state changed; affected
execution tests use disposable synthetic fixtures.
The disabled privacy contract and native controller remain unchanged.

## Proven routing cause

Native app.uat2.main mounted GET /runs/{run_id} before installing the workflow
router's GET /runs/analysis-workflows. Starlette's first full match therefore
selected the legacy get_run endpoint. Its actual FastAPI path field and standard
validation handler reproduce the hosted response exactly: HTTP422,
type=int_parsing, loc=[path,run_id], input=analysis-workflows.

The minimal fix mounts the existing workflow router before the legacy read-only
job/run routes. No handler, route shape, runtime binding, owner fence or module
policy changes. Existing /runs and numeric /runs/{run_id} still resolve correctly.

New tests inspect the actual native application's ordered routes, not a small
standalone analysis-router harness. They assert the default hosted binding,
no dependency overrides, static/config/detail/POST resolution and anonymous401
responses. The observed legacy error is reproduced without installing preview
or disposable runtime bindings. Before repair, the collection-route regression
failed (one failed,nine passed); after repair all10 new cases pass.

The existing disposable native PostgreSQL/Redis HTTP probe now also checks
config and GET collection routes and verifies a completed workflow appears in
that collection. Earlier probes exercised POST/detail paths and missed this
registration defect. This authenticated-container assertion is prepared, not
locally executed; Docker/PostgreSQL are unavailable on this executor.

## Transient order read versus misleading diagnostic

Hosted browser evidence was corrected: recorded order status initially failed,
then explicit Refresh recovered to the existing empty-history response with its
broker/positions disclaimer. This is not treated as a persistent backend defect.
Positions' unavailable warning and existing runtime-role restriction were not
changed. The disabled US-module restriction remains intentional and unchanged.

Recovery diagnostics independently counted recorded unresolved rows and rendered
“No unresolved order state in these records” for a quiet observation. That could
coexist with unavailable/loading order history. Its false branch now states that
a separate recorded-history check is required and that the diagnostic does not
establish whether orders are unresolved. Positive unresolved findings still warn
against resubmission. No API fields, privileges, timeouts or retry behavior changed.

Five new component-hook tests execute the actual transpiled diagnostics/order
components for unavailable/loading/recovered-empty history, positive unresolved
observations and foreign-owner rejection. Three cases failed before the wording
repair; all five pass afterward. These are component tests, not hosted browser
acceptance. Both new regression files are included in existing CI test commands.

## Verification and remaining hosted check

- 36 focused Python checks passed, including10 actual route/auth regressions and
  existing native runtime/order checks.
- 54 checks passed using the updated native CI pytest command, zero skips.
- 20 relevant frontend component checks passed, zero skips.
- Six source baseline checks passed; regenerated inventory has zero unresolved
  entries. The two Python runs overlap and must not be added together.
- Independent review found no concrete defect in route ordering or diagnostic
  uncertainty handling; owner/positions/module-off behavior was preserved.

Current deployed342fea is not changed by this local repair. Exact-candidate CI,
including the strengthened authenticated PostgreSQL/Redis probe, and separately
authorized deployment are required before hosted retest. With original preferences
preserved, owner acceptance should confirm collection/config requests no longer
produce run_id parsing errors; unavailable/loading order history never receives
a diagnostic clearance; explicit order refresh can recover with its existing
empty-history disclaimer; positions and disabled modules remain appropriately
restricted. Business-flow actions still require their own authorized acceptance.
