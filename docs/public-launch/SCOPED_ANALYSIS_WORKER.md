# Scoped simulation policy and durable analysis worker (local candidate)

Implementation started 2026-10-23 20:41:39 UTC. Verification completed 2026-10-23 21:13 UTC.

This change adds explicit SQL-session simulation policy bindings and a caller-owned Celery analysis worker. It does not install them into the hosted application or change the existing UAT2 deployment. Unbound applications still deny optional UAT2 modules. The binding rechecks owner, environment, current fake connection, module selection, lifecycle and execution capability; it never grants action confirmation.

The worker consumes existing durable stage messages and governed jobs, scopes relay queries to the allowed synthetic owners and analysis job kind, and preserves cancellation, disable, claim recovery and duplicate delivery behavior. Registration and relay validate JSON serialization and the dedicated transport. Hosted mode requires the existing PostgreSQL/Redis UAT2 configuration; local tests use disposable SQLite and memory transport. Scheduling only relays already persisted work; it does not create analyses or approve execution.

Validation: 321 focused tests passed, zero failures/errors/skips, including 15 new scoped-policy/worker cases. Source inventory check passed: 314 HTTP routes, 48 workers, 17 scheduler entries, no unresolved entries. The PR workflow includes an exact 15-case zero-skip gate. These are local results, not PostgreSQL/Redis or exact-source remote CI evidence.

Remaining H1 work includes complete application startup/session composition, keyless fake connection lifecycle in both modes, durable source versioning across same-day reconnects, immutable analysis-to-basket binding and fake execution/reconciliation composition, then exact-source hosted acceptance after deployment approval. Privacy export/erasure across all stores and external evidence gates remain separately incomplete. Earlier browser repair code 159843a has passing fresh local browser evidence recorded in SOURCE_BROWSER_REPAIR.md; neither that repair nor this worker candidate has been published.
