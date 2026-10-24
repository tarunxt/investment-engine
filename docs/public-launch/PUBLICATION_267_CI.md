# Published candidate 267b476: exact-source CI result

Public draft PR1262 was fast-forwarded from
6f3214c9e015f0d3a510cde487318b2ba4fb8cde to the explicitly approved exact candidate
267b4760df4773e9ded1f2ac030c106f872627fc. Git remote and PR head were independently
read back. No deployment, force push or later successor publication occurred.

- [Baseline run40066949955](https://github.com/tarunxt/investment-engine/actions/runs/40066949955): passed.
- [API migration run40066949960](https://github.com/tarunxt/investment-engine/actions/runs/40066949960): passed.
- [PR checks run40066950095](https://github.com/tarunxt/investment-engine/actions/runs/40066950095): terminal failure, 51 successful jobs and three failed jobs; no skipped jobs in the 54-job conclusion tally.

## Verified runtime evidence, separate from overall failure

UAT2 job120792102923 passed its disposable PostgreSQL/Redis HTTP/task workflow
and actual worker restart. The recovery receipt records original-account
reconciliation to filled, exactly one submission attempt and one venue receipt,
typed native evidence export, full_account_export=false and owner_acceptance=false.
This is CI evidence, not deployment or hosted owner acceptance.

Stage17 job120792103135 passed 418 tests and its no-skips/exact-count gate,
including the canonical PostgreSQL composition and real-service checks. It does
not prove complete legal/privacy implementation. Later local policy work is not
part of this published SHA or these results.

## Exact failures and outstanding repairs

1. Job120792102814, synthetic journal/recoverable privacy PostgreSQL: 41 passed,
   one failed. test_pg_recoverable_erasure_roundtrip_is_atomic_and_owned raises
   PRIVACY_RECOVERY_STORE_ADAPTER_UNAVAILABLE because its generic recovery
   fixture still expects API-key restoration. The generic adapter intentionally
   excludes credential restoration after the reviewed safety fix. Align the
   fixture with explicit quarantined recovery; do not re-enable generic keys.
2. Job120792103057, Stage16: the acquisition-journal suite executes 11 passing
   cases but its CI assertion expects13. That assertion stops subsequent native
   order/privacy steps in this job; do not count those later steps as executed.
   Inspect actual collected cases and update only the stale expected count.
3. Job120792103031, webpack frontend runtime: login JavaScript transfer measured
   195079 bytes, decoded623169 bytes across11 files, exceeding the retained
   10-percent growth budget. Turbopack's separate job passed. Diagnose measured
   bundle growth; no budget weakening or baseline change is authorized here.

These three repairs are not included in the new local privacy-policy work. The
candidate remains unsuitable for deployment until reviewed repairs and their
exact-source CI pass. No all-green, complete hosted, complete-erasure or owner
acceptance claim is made.
