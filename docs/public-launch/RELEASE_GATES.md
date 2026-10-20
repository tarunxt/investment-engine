# UAT2 development and release gates

Current authority: CURRENT_SPECIFICATION.md and revised stages/00–20 from the new UAT2 pack. Earlier gate ledger is preserved in history/RELEASE_GATES-pre-uat2-pack-137fce50.md. Historical older UAT is deferred, not the active prerequisite.

| Gate | State | Required evidence |
| --- | --- | --- |
| Revised 00 UAT2 READY | Parent/UAT2 task pending final verification | Preserve actual existing stack/evidence; finish missing HTTPS/barrier/owner/nonowner/alternate auth/logout/expiry/cookie/WS checks; actual PostgreSQL/Redis, fake adapters/no-egress, bounded resources and repeatable deployment/recovery |
| Current authorization | Must remain valid | Existing budget/shutdown/retention limits, no silent renewal. Pack-reported stop target21Oct2026 21:04IST must be checked against authoritative current limit |
| Stage 01 source and overlap reconciliation | Baseline implemented; map published | Current complete01, ledgers/inventory/fixtures and STAGE01_REQUIREMENT_MAP.md; no assumption of02/06–08 completion |
| Local/CI | Pre-sync137fce50 CI PASS; new exact candidate PENDING | Exact-head tests, preserved guard/runtime roots, no new migration; earlier runtime results reused only where unchanged |
| Native Linux artifact | Old137fce50 verified in CI; new candidate PENDING | Exact source stamp, immutable ZIP digest, manifest, complete wheels/archives, audit, roundtrip and Linux offline install; retain before existing expiry |
| Stage 01 UAT2 deployment | NOT performed here | Parent confirms READY, UAT2 task uses existing approved controller/backup/rollback and verifies exact new candidate |
| Stage 01 UAT2 verification | Pending | Existing screens/negative cases on actual deployed SHA, not localhost; preserve previous valid results |
| Owner review | Pending after deployed Stage 01 | Exact UAT2 pages/actions/expected results; owner reviews before 02 |
| Later stages | NOT STARTED | Sequential prerequisites;02 ownership,06–08 modules,20 cutover preparation only |
| External approvals | Pending | Both Kite modes/provider/legal, products/capacity/privacy decisions remain explicit. Mock tests do not grant approval |
| Production | NOT AUTHORIZED | No main merge/deploy/production migration/financial flags, public-registration activation or real orders. Separate future cutover instruction |

No access expansion, new public test accounts, resource provisioning, provider/paid-limit changes or old-UAT recovery. UAT2 remains exact owner only and simulated. No dummy UI is needed to display a backend/baseline stage. Current workflow triggers and runtime trees are preserved; PR #1241 stays a UAT2-targeted draft.

## Post-Stage20 UAT2 stop reminder — user checklist,20October2026

- [ ] After **all** Stage20 work is complete, full UAT is explicitly accepted, the separately authorized UAT2-to-production migration has finished, and live post-deployment verification has passed, remind the user: **Stop UAT2 EC2 instance `i-0d1d4a0b841c98691` until the next testing session.**
- [ ] Before proposing that stop, verify the actual instance identity and that no running jobs, queues, schedules or dependent services still require UAT2; resolve any dependency before recommending shutdown.
- [ ] Treat the user's spoken “Docker AWS server” as this UAT2 EC2 instance, **not local Docker Desktop**. This item authorizes a reminder only: no stop now, automatic stop/migration, production cutover, termination/deletion, budget/retention extension or infrastructure action.
- [ ] Preserve the existing earlier UAT2 shutdown control even if these later conditions have not occurred. This reminder cannot postpone or override it. Recheck its authoritative current source through the existing sole executor before use; do not infer renewal from this checklist.

Source/limit evidence: the existing Current authorization gate above and saved stages/20.md preserve the19October handoff's reported shutdown target. The retained exact-source Stage06 handoff records the inherited limit, but this documentation-only change has **not** independently inspected the live shutdown control. No new exact shutdown guarantee or changed limit is asserted here. No automation was created. Stage07 implementation scope remains unchanged; this is a future release checklist item, not a start of Stage20 or authorization to execute its cutover.
