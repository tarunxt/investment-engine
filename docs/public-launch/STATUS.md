# Public-launch implementation status

## Current authority and stage

Use CURRENT_SPECIFICATION.md and complete stages/00.md through 20.md synchronized from the new 19 October UAT2 pack. It supersedes earlier pack/destination/prerequisite language. The HTML is unchanged. Historical ledgers and previous01 are preserved under history/ and stages/archive/. Old UAT recovery is DEFERRED and not a prerequisite; no old resource actions. Revised 00 verifies existing UAT2, preserving valid evidence and current access/budget/shutdown limits.

Stage 01 alone is active. PR #1241 / codex/stage01-uat2-integration-20261019 is the UAT2-only candidate; PR #1240 remains historical source/preview evidence. Source before this synchronization:137fce503eea7d22fecd4c935931cf0e72e81282. New exact candidate is current PR #1241 head. Backend/frontend/scripts and existing workflows are preserved. The separately reviewed UAT2 reset-controller fix and one focused native regression are incorporated; other deployment guards remain unchanged. No migration or module/tenant implementation is added. See STAGE01_REQUIREMENT_MAP.md. Stages02–20 are NOT STARTED; owner must review deployed Stage 01 before 02.

| State | Evidence / limit |
| --- | --- |
| Code | Baseline inventory/ledgers/fixtures/preview implemented; current spec and requirement map synchronized; runtime/guards/migrations preserved |
| CI | Pre-sync137fce50 baseline and full PR Checks SUCCESS, including native Linux package/audit/roundtrip/offline install. New exact docs-candidate CI/native artifact PENDING; old result is not transferred |
| UAT2 deployment | NOT performed by this task. UAT2 task owns live actions after parent confirms revised 00 READY and valid existing cost/deployment authority |
| UAT2 verification | Pending parent/UAT2 evidence at exact deployed SHA; preserve previously verified results and rerun only invalidated/missing checks |
| Owner acceptance | User-reported login is acknowledged; full readiness and deployed Stage 01 review remain separate pending gates |
| External approval | No new provider/legal approval; real orders/integrations/paid AI remain outside simulation-only scope |

## Preserved checks and explicit gaps

Candidate137fce50: baseline 5, Google/UAT2 policy/runtime 44, native-controller15, configuration6 (one Docker-dependent syntax check skipped), cookie6; inventory/compile/diff checks pass. Earlier ddefd730 localhost42 API/BFF, frontend build/type and synthetic A/B browser walkthrough passed; that is local evidence only. Previous full results/logs remain in archived STATUS and evidence files. No broader certification.

Current production population/owner-ID audit remains UNKNOWN through an admitted route. Both Kite approval/product/capacity/retention decisions remain tracked. PostgreSQL/Redis CI and actual UAT2 runtime evidence are distinct; SQLite is not parity. The transient sidebar theme mismatch remains a reported observation, not a repaired issue. Original02 ownership and06–08 modules are missing in PR #1240's actual runtime diff; retain numbering and do not create duplicates.

The Mac exec-server was initially disconnected, then resumed after explicit user confirmation. The clean worktree fast-forwarded to 389a840a; all 16 native tests, including mocked reset-command regression, passed. The controller executable bit was restored to its original 100755. Final exact-head CI/artifact verification remains required; no local artifact-byte result is claimed yet. Denied preview HTTP/PID probes were not retried, no process was restarted and pending approval was not inferred granted. Last recorded localhost URL http://localhost:54987/console/profile/preferences is historical/local-only and not stable or deployed UAT2.

## Handoff

Parent/UAT2 task completes only outstanding revised 00 acceptance, verifies current authorization limits, then deploys an exact CI/artifact-verified Stage 01 candidate through the existing controller. Report deployed SHA and clickable https://uat2.cred-x.in/console/dashboard, /console/profile, /console/profile/preferences and /console/uat2 only after checking what is actually deployed. For this baseline-only stage, review existing screens and test evidence; do not invent module UI. Include logout/session/cookie/direct unauthorized/WS/fake-adapter negatives. Record owner review before 02; no main merge/production deployment or real broker action.


## Required UAT2 reset correction incorporated

Exact reviewed fix:79acc235da9f3ba7babb0b640c97442761b1da3f; UAT2 evidence head 3497ff5cc6072ee3bb7ad3847d55d567f5702e58. The change is limited to the existing controller reset action: use the application backend working directory and import the serving model registry before running the fixture-reset module under the same unprivileged service identity. Existing owner/barrier/resource controls are unchanged. A focused native unit regression now checks both empty and populated reset command construction, cwd, model bootstrap and PYTHONPATH without executing a reset. Its result is PENDING exact-candidate CI; no local pass is claimed while Mac exec is unavailable. UAT2 task reports the fix is not installed; serving app4a8e81ab and controllerc72d41ad remain live. Do not deploy or run reset here. No Stage 02 implementation.


## India simulation contract successor

Reviewed and integrated UAT2 commit 503f86ee8623d1dbeb25ce7adaa9b5a1364b7b96. Its only code changes enrich synthetic holding market/invested/day-change values and provide the simulated status login_time/expires_at contract expected by the existing UI; regression assertions are in test_uat2_runtime.py. No real adapter, production domain, owner guard, credential, trading permission, migration or frontend behavior is enabled. Relevant Google/UAT2 policy/runtime 44 tests and baseline 5 tests pass locally after this merge; source inventory and affected manual route-line references are refreshed. The existing reset regression/controller source is preserved. Exact successor CI/native artifact remain required.

The fully verified 2728100d artifact is preserved as historical evidence only and must not be deployed as this successor. Parent reports reset79acc235 installed and 15 host tests plus owner/private-state checks passed; this task performed no live actions and does not claim UAT2 READY. UAT2 task owns installation/acceptance of this India fix and any Stage 01 deployment after parent handoff. Stage 02 remains unstarted.
