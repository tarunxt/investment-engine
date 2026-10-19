# Public-launch implementation status

## Current authority and stage

Use CURRENT_SPECIFICATION.md and complete stages/00.md through20.md synchronized from the new 19 October UAT2 pack. It supersedes earlier pack/destination/prerequisite language. The HTML is unchanged. Historical ledgers and previous01 are preserved under history/ and stages/archive/. Old UAT recovery is DEFERRED and not a prerequisite; no old resource actions. Revised00 verifies existing UAT2, preserving valid evidence and current access/budget/shutdown limits.

Stage01 alone is active. PR1241 / codex/stage01-uat2-integration-20261019 is the UAT2-only candidate; PR1240 remains historical source/preview evidence. Source before this synchronization:137fce503eea7d22fecd4c935931cf0e72e81282. New exact candidate is current PR1241 head. Backend/frontend/scripts and existing workflows are preserved. The separately reviewed UAT2 reset-controller fix and one focused native regression are incorporated; other deployment guards remain unchanged. No migration or module/tenant implementation is added. See STAGE01_REQUIREMENT_MAP.md. Stages02–20 are NOT STARTED; owner must review deployed01 before02.

| State | Evidence / limit |
| --- | --- |
| Code | Baseline inventory/ledgers/fixtures/preview implemented; current spec and requirement map synchronized; runtime/guards/migrations preserved |
| CI | Pre-sync137fce50 baseline and full PR Checks SUCCESS, including native Linux package/audit/roundtrip/offline install. New exact docs-candidate CI/native artifact PENDING; old result is not transferred |
| UAT2 deployment | NOT performed by this task. UAT2 task owns live actions after parent confirms revised00 READY and valid existing cost/deployment authority |
| UAT2 verification | Pending parent/UAT2 evidence at exact deployed SHA; preserve previously verified results and rerun only invalidated/missing checks |
| Owner acceptance | User-reported login is acknowledged; full readiness and deployed Stage01 review remain separate pending gates |
| External approval | No new provider/legal approval; real orders/integrations/paid AI remain outside simulation-only scope |

## Preserved checks and explicit gaps

Candidate137fce50: baseline5, Google/UAT2 policy/runtime44, native-controller15, configuration6 (one Docker-dependent syntax check skipped), cookie6; inventory/compile/diff checks pass. Earlier ddefd730 localhost42 API/BFF, frontend build/type and synthetic A/B browser walkthrough passed; that is local evidence only. Previous full results/logs remain in archived STATUS and evidence files. No broader certification.

Current production population/owner-ID audit remains UNKNOWN through an admitted route. Both Kite approval/product/capacity/retention decisions remain tracked. PostgreSQL/Redis CI and actual UAT2 runtime evidence are distinct; SQLite is not parity. The transient sidebar theme mismatch remains a reported observation, not a repaired issue. Original02 ownership and06–08 modules are missing in PR1240's actual runtime diff; retain numbering and do not create duplicates.

Mac exec-server is disconnected. Do not claim local new-candidate tests, artifact-byte verification, preview health or PID verification. No retry of denied preview probes, no process restart, no approval inference. Last recorded localhost URL http://localhost:54987/console/profile/preferences is historical/local-only and not stable or deployed UAT2.

## Handoff

Parent/UAT2 task completes only outstanding revised00 acceptance, verifies current authorization limits, then deploys an exact CI/artifact-verified Stage01 candidate through the existing controller. Report deployed SHA and clickable https://uat2.cred-x.in/console/dashboard, /console/profile, /console/profile/preferences and /console/uat2 only after checking what is actually deployed. For this baseline-only stage, review existing screens and test evidence; do not invent module UI. Include logout/session/cookie/direct unauthorized/WS/fake-adapter negatives. Record owner review before02; no main merge/production deployment or real broker action.


## Required UAT2 reset correction incorporated

Exact reviewed fix:79acc235da9f3ba7babb0b640c97442761b1da3f; UAT2 evidence head3497ff5cc6072ee3bb7ad3847d55d567f5702e58. The change is limited to the existing controller reset action: use the application backend working directory and import the serving model registry before running the fixture-reset module under the same unprivileged service identity. Existing owner/barrier/resource controls are unchanged. A focused native unit regression now checks both empty and populated reset command construction, cwd, model bootstrap and PYTHONPATH without executing a reset. Its result is PENDING exact-candidate CI; no local pass is claimed while Mac exec is unavailable. UAT2 task reports the fix is not installed; serving app4a8e81ab and controllerc72d41ad remain live. Do not deploy or run reset here. No Stage02 implementation.
