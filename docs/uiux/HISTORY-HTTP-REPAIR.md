# Native UAT2 history HTTP repair

Prepared locally after parent hosted acceptance on deployed `7eb27bd133cad5f05d08b48cd313367a5d858ab3`. Work started 24 October 2026 at 19:57:09 UTC; application/test repair saved at 20:05:13 UTC as `45b3fb60319994cfdbe7dc22efef13f56a9b7e1c`. No publication, server change or deployment is included.

## Root cause and bounded fix

Both canonical UI histories call GET `/runs/auto-rebalance-history` with portfolio `india` or `indmoney_us`. The restricted native composition omitted this existing handler, so `/runs/{run_id}` captured the collection path and returned int_parsing for input auto-rebalance-history. The detail read was also omitted.

Only the existing collection and detail GET handlers are now mounted in their original static-before-dynamic order. Stage writes, reservation/dispatch, cancellation and other legacy mutation siblings remain unmounted. Existing numeric run reads, authentication and native startup/owner fences remain intact. The generated source inventory and restricted composition matrix were updated.

A disposable adversarial regression also proved that the existing legacy history helper could serialize another owner's job through a corrupt RunJob link. Ordinary run reads already reject that graph. The helper now reuses that exact owned-run predicate and excludes workflows with foreign/missing stage job/run evidence. This synthetic finding is not evidence of a hosted data leak. No actual user data was inspected or erased.

## Verification

- 43 native-routing/private HTTP ownership cases passed, zero failures/skips. Real JWT authentication and both portfolios exercise the actual native ASGI route table, successful owned list/detail reads, foreign-owner 404, unauthenticated 401, inactive-user 403, spoofed owner ignored, invalid portfolio rejection and unavailable PATCH. Corrupt nested jobs and independent foreign job/run stage pointers cannot be exposed. Workflow/job/outbox counts are unchanged by requests.
- 105 existing legacy history/audit regressions passed, zero failures/skips.
- Inventory --check and diff/syntax checks passed. No CI test count or guard was lowered. The native route test file was added to the existing disposable PostgreSQL ownership job; the existing SQLite UAT2 job already includes it.

These local HTTP tests use the existing disposable SQL dependency fixture, restoring the override afterward; authentication/runtime dependencies and application source are not overridden. Native hosted startup is not activated. This is SQLite evidence, not local PostgreSQL or hosted acceptance. An initial test entered the native lifespan without an authorized hosted environment and correctly failed; it was corrected to test ASGI routing without pretending to qualify startup. The corrupt-relationship failure is retained privately alongside passing evidence.

## Separate unresolved readiness check

The reported Zerodha setup/source/connection/approved-plan failure is unchanged. Saved six-stage history does not establish a current binding. This patch does not renew a connection, acquire a source, enable Start, alter credentials or weaken freshness/approval checks. Determining the exact hosted cause requires read-only current binding/source metadata from the authorized deployment/acceptance worker; expiry is not inferred here.

New publication approval, exact-head CI (including PostgreSQL) and a separate hosted retest are pending. No external provider access is required to implement this history fix. Production, roles, allowlists, live orders and real deletion remain untouched.
