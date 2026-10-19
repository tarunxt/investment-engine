# Stage01 UAT2 integration candidate

Current authority is CURRENT_SPECIFICATION.md and the new complete UAT2 stages00–20. Prior version is preserved under history/UAT2_INTEGRATION-pre-uat2-pack-137fce50.md. Revised00 verifies existing UAT2 READY; older UAT is deferred and not a prerequisite. UAT2 task deploys after parent verifies READY under current valid authorization; owner reviews deployed01 before02. This task synchronizes documentation only; local exec is disconnected and no live/deployment action is performed. Stage01 overlap is mapped in STAGE01_REQUIREMENT_MAP.md, not inferred from handoff text.

## Source and review boundary

Branch: codex/stage01-uat2-integration-20261019. Candidate commit is the latest draft PR head / git rev-parse HEAD; never substitute main or an earlier artifact. Current published UAT2 base:3497ff5cc6072ee3bb7ad3847d55d567f5702e58, including reset fix79acc235. Historical base:c40f112d9259592256df4e5db5646f5d8915f0a6. Local task-3 base 74c2187cc324a4d4c16ecc3f264bb5e294f6b953 has the identical tree ce2571f49747158cee276c79b3b40c0ea10793e9 with different history/metadata. Both ancestries are retained through non-destructive merges, together with tested Stage01 ddefd7306003dc8e4e662d3b88abe167da77f036 and original baseline f25811dd. No original checkout was reset or edited.

The pre-sync integration merge was conflict-free. The new instruction synchronization is documentation-only; backend/frontend/deploy/scripts/workflow trees remain unchanged. Current source review preserves backend/frontend/scripts/workflow trees. The native controller equals reviewed UAT2 reset fix79acc235; the only additional deployment-tree change relative to3497ff5c is the focused reset-command unit regression. The pre-sync137fce50 runtime preservation check againstc40f112d remains historical evidence, not a claim about the reset fix.

```sh
git diff --exit-code 3497ff5cc6072ee3bb7ad3847d55d567f5702e58 HEAD -- backend frontend scripts .dockerignore .github/workflows
# Expected deployment delta vs3497ff5c: deploy/uat2/native/test_native.py only.
```

Google fixes #1235 / 385f61888dfab13ceac1a960f9e508626f407a35 and #1236 / 0c6e61e524c7a87c7b9ea79342f17b14a45e97a1 remain ancestors. Stage01 adds ledgers/inventory, synthetic fixtures, optional localhost harness and a PR-only baseline workflow. No migration or runtime behavior change. Synthetic local test users must never be admitted to public UAT2.

The earlier uploaded pack matched the recovered prompt; that comparison is historical. The NEW UAT2 pack changes the active boundary, prerequisite, reconciliation and delivery requirements; complete current prompts are synchronized without changing the HTML. See evidence/prompt-pack-comparison-20261019.json. Stage01 is baseline; modules belong to 06–08. Existing UAT2 wording about Stage01 module controls is historical, not implementation authority. Stage20 is cutover preparation only.

## Preserved pre-sync checks and new candidate gate

The results below were actually run for137fce50 before the new pack/reset-fix reconciliation. They are preserved evidence, not a claim that the new exact candidate has passed. The added reset-command regression must run in the new native CI job; local exec is disconnected.

### Prior commands and results

Run inside this candidate worktree using an isolated Python environment installed from existing constrained requirements:

```sh
python3 scripts/public_launch/inventory.py --check
PYTHONPATH=backend python -m pytest -q scripts/public_launch
PYTHONPATH=backend DATABASE_URL=postgresql+psycopg2://synthetic_test:unused@127.0.0.1:1/uat2_unit_only REDIS_URL=redis://127.0.0.1:1/0 ENVIRONMENT=test AUTH_DISABLED=false python -m pytest --noconftest -q backend/tests/test_google_signin.py backend/tests/test_uat2_policy.py backend/tests/test_uat2_runtime.py
PATH=/usr/bin:/bin python -m unittest discover -s deploy/uat2/native -p 'test_*.py' -q
PATH=/usr/bin:/bin python -m unittest discover -s deploy/uat2 -p 'test_*.py' -q
node --test frontend/tests/auth-session-cookie.test.mjs
python3 -m compileall -q scripts/public_launch backend/app
git diff --check
```

Baseline: 5 PASS. Google/UAT2 policy/runtime: 44 PASS. Native controller: 15 PASS. Configuration: 6 PASS, one Docker-dependent syntax test SKIPPED. Cookie/session Node tests: 6 PASS. Regenerated inventory --check, compileall and diff checks PASS. The unused PostgreSQL URL opens no database connection; these are policy/unit tests, not PostgreSQL integration. Initial combined collection used in-memory SQLite, whose StaticPool rejects existing app pool settings; correcting the test URL to documented UAT2 CI setup passed without source change.

Inventory now covers combined UAT2 source (260 HTTP/5 WebSocket/43 workers plus documented other categories). UAT2_ENTRYPOINT_MATRIX.md separately maps restricted app.uat2.main, filtered US GET routes, disabled documentation/WS and dedicated fake worker; production app.main mount labels do not mean all routes are exposed in UAT2. Guard hashes and runtime preservation are recorded in evidence/stage01-uat2-source-review-20261019.json.

Earlier localhost evidence (42 API/BFF checks, real frontend build/type and interactive A/B walkthrough) belongs to Stage01 ddefd730, not a deployed integration candidate. Its URL remains http://localhost:54987/console/profile/preferences, frontend PID58613/port54987 and backend PID58612/port54988, in task-5/investment-engine. Preserve its synthetic SQLite and fake-unavailable adapters. Do not point it at UAT2 DB or copy owner credentials. Native UAT2 artifacts require Linux x86_64/Python3.12/Node22; Mac builds do not establish that result.

## Exact remaining gates

1. Parent verifies and records genuine UAT2 owner acceptance at the current deployed SHA. Reported login/screenshot proves login, not every barrier/cookie/direct-API/WS/sandbox/empty-populated requirement. Preserve current owner session/profile and approved limits. Older UAT is deferred; revised00 verifies existing UAT2 READY and does not require the old gate. Do not touch old resources or infer a retroactive PASS.
2. Inspect this candidate's exact-head baseline and PR-check CI, including inherited UAT2 native contracts/package and disposable PostgreSQL/Redis jobs. Pending/queued is not PASS. Earlier UAT2/Stage01 CI cannot substitute. Do not dispatch production workflows or change a pipeline to bypass a failure.
3. Obtain the complete native uat2-native-bundle-<candidate-SHA> and verification receipt before existing one-day CI expiry. Recheck source/platform/build stamp, ctl.py inspect-bundle, package.py audit and Linux offline-check. No host build or Docker launch here. Existing native package intentionally includes backend/deployment runtime only; Stage01 ledgers/fixtures remain repository review artifacts, not newly exposed host endpoints.
4. Parent/UAT2 task alone coordinates authorized UAT2 transfer/deployment after owner acceptance. Use unchanged guarded controller, fresh UAT2-only backup and recorded prior release/rollback receipt. No initialize/reset, owner reprovisioning, new secret, access/budget/retention change or financial/integration flag change is needed. This task executes none of those actions.
5. After separately coordinated deployment, verify exact candidate build stamp, preserved owner session/profile, anonymous barrier for pages/assets/API/WS, nonowner/direct/password denial, separate cookies, no-egress/fake-worker/no-Beat behavior and both synthetic portfolio states within admitted UAT2 scope. Parent/UAT2 task records approved production health checks and rollback evidence. No real provider/email/order or synthetic multi-user public admission. Record parent Stage01 acceptance before Stage02 begins.

Current state: SOURCE REVIEWED; preserved137fce50 LOCAL/CI PASS; new exact-head tests/native artifact PENDING; UAT2 DEPLOYMENT NOT RUN; PARENT ACCEPTANCE PENDING; PROVIDER APPROVAL NOT IMPLIED. Stage02–20 NOT STARTED. No production merge/deployment, AWS operation, Docker launch, new resource, security/access or paid-limit change is performed here.


## Required UAT2 reset correction incorporated

Exact reviewed fix:79acc235da9f3ba7babb0b640c97442761b1da3f; UAT2 evidence head3497ff5cc6072ee3bb7ad3847d55d567f5702e58. The change is limited to the existing controller reset action: use the application backend working directory and import the serving model registry before running the fixture-reset module under the same unprivileged service identity. Existing owner/barrier/resource controls are unchanged. A focused native unit regression now checks both empty and populated reset command construction, cwd, model bootstrap and PYTHONPATH without executing a reset. Its result is PENDING exact-candidate CI; no local pass is claimed while Mac exec is unavailable. UAT2 task reports the fix is not installed; serving app4a8e81ab and controllerc72d41ad remain live. Do not deploy or run reset here. No Stage02 implementation.
