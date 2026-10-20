# Stage09 isolated successor review and publication plan

Current phase is local implementation/preparation only. No push, new PR, deployment, AWS change, credential operation, real provider call or shared-service start is authorized in this phase. Stage10 is excluded. Accepted/live UAT2 remains Stage08 `61ce447ba35f4db7cd06fd550c62557450247af3`, owner-only simulation.

## Identity and retained findings

Successor worktree: task-3/stage09-recovery-successor. Unique branch: `codex/stage09-recovery-successor-20261020-task3`. Base is immutable Stage09 `fc4d51313e2d86e5bc807ad91db877a26aa0bb89`, itself based on accepted Stage08. The exact candidate is this document's containing commit, available with `git rev-parse HEAD`; the parent handoff records its full SHA. The original task-5 checkout/branch/processes are not modified or stopped.

Read full stages/09.md and synchronized SEQUENTIAL_UAT2_PLAN.md, STATUS.md, CURRENT_SPECIFICATION.md, RELEASE_GATES.md and applicable AGENTS before edits. The pre-fix independent review is retained in evidence/stage09-independent-pre-fix.json, including exact failure identities, normalized error hashes and source comparison. Original raw logs and immutable review archives remain in task-3. Source review of fc4d513 found no blocking binding/storage issue; that does not establish PostgreSQL, CI or UAT acceptance.

Fresh targeted runs of all nine affected frontend files on exact Stage08 and Stage09 archives each produced 67 passed/14 failed. All 14 identities and normalized error bodies match, and every affected test file is byte-identical. Only checkout roots/stack frames were normalized; expected/actual/error details are preserved. These are unresolved baseline failures, not waived checks. No frontend source changed in this successor, so no duplicate build or broad suite was run.

## Four legacy recovery failures accounted for

Both committed snapshots reproduce four failures, with the same identity/signature when each uses its committed fixture. However fc4d513 added two imports and changed setUp from unbound ZerodhaService to explicit fake AppMaterial. All six original test method bodies were unchanged, but the test file was not. The earlier unqualified unchanged-source claim is superseded.

The unchanged Stage08 test file was also run against exact Stage09 application source. Two errors change: discovery's `direct_market_orders_enabled` assertion fails (`False is not true`), and the sequenced route returns HTTP503 before the old expected HTTP200. Stage09 no longer derives a binding from global environment keys. This is intended fail-closed behavior, not evidence that credentials should be reintroduced globally. The remaining two errors still reject missing trusted module context.

| Original test method | Pre-fix error with committed fixtures | Successor contract |
| --- | --- | --- |
| test_scoped_manual_order_reaches_mock_broker_and_scope_is_reset | ModuleLifecycleDenied: Trusted module execution context required | Renamed to test_scoped_manual_order_requires_execution_authority_and_scope_is_reset; narrow recovery validator accepts the protected shape inside scope, denies after reset, and public adapter still refuses absent module authority with a valid fake BoundToken. No transport call. |
| test_exception_does_not_enable_background_trading_or_other_mutations | Same missing-context error instead of expected RecoveryBlocked | Assert malformed/unprotected/leverage orders fail the recovery validator; assert public adapter additionally denies missing module context. Generic financial/Bullpen/task/cancel paths remain blocked. |
| test_opt_out_revokes_both_discovery_and_scoped_transport | Same missing-context error instead of expected RecoveryBlocked | Assert discovery/middleware opt-out, recovery validator denial even inside scope, and independent public adapter denial. No transport call. |
| test_real_sequenced_route_submits_only_the_explicit_manual_sell | placed_count0 versus expected1; logged missing-context denial | Renamed to test_real_sequenced_route_cannot_submit_without_execution_authority; unbound service returns503; explicitly bound service+fake session reaches real handler but records zero placed/one failed and no provider request. Generic order endpoint remains503. |

An additional regression proves fake global settings never configure an unbound service, and bare tokens are rejected. Explicit AppMaterial/BoundToken are test fixtures only; they are not module, confirmation or provider authority. The HTTP mock is retained as a tripwire, and all these tests require zero broker requests. No application/runtime authorization code, registry, connection resolver, migration or production flag was changed. Positive connection-mode/fake-transport contracts remain in test_stage09_connections.py. Real order authority/flow remains outside this stage.

## Verification performed

From this successor, using the existing Python dependency runtime with bytecode/cache writes disabled and unused synthetic database/Redis addresses:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend ENVIRONMENT=test AUTH_DISABLED=false \
DATABASE_URL=postgresql+psycopg2://unused:unused@127.0.0.1:1/unused_test \
REDIS_URL=redis://127.0.0.1:1/15 \
python -m pytest -q -p no:cacheprovider --disable-warnings --tb=short \
  backend/tests/test_zerodha_manual_recovery.py \
  backend/tests/test_stage09_connections.py \
  backend/tests/test_stage07_lifecycle.py \
  backend/tests/test_stage06_modules.py \
  backend/tests/test_recovery_containment.py
```

Result: **171 passed**, 3100 warnings, 11.29s; this includes 7 recovery and 23 Stage09 connection tests. See evidence/stage09-successor-local.json. These are local synthetic results, not the mandatory PostgreSQL or CI gate. Test-source repairs are explicit contract updates, not claims that the old assertions now pass unchanged.

## Mandatory PostgreSQL plan

The existing dedicated `stage09-connection-bindings` job in .github/workflows/pr-checks.yml uses Python3.13 inside Docker and PostgreSQL16 service host `postgres`. It must run the exact PR head SHA; this successor adds that explicit checkout ref. Three tests use separate async sessions and concurrent gather for one-current provisioning, rotation CAS and disable/rotation safety. A fourth runs actual Alembic subprocess upgrades from module_lifecycle_001 to head, repeated downgrades/upgrades, baseline schema/data comparison and opaque legacy ciphertext retention. Random per-test schemas are created/dropped; this is intentionally destructive to that disposable fixture only. Concurrent gather is coverage of competing writers, not an exhaustive scheduling or load proof.

Required dependencies are backend/requirements.txt plus pytest, pytest-asyncio and aiosqlite0.22.1. Required environment inside the named backend test container:

```sh
export PYTHONPATH=backend ENVIRONMENT=test AUTH_DISABLED=false
export DATABASE_URL=postgresql+psycopg2://stage09:stage09@postgres:5432/credx_stage09_test
export REDIS_URL=redis://127.0.0.1:1/15
export CREDX_STAGE09_DATABASE_ACK=disposable-docker-only
python -m pytest -q --junitxml=/tmp/stage09.xml \
  backend/tests/test_stage09_connections.py \
  backend/tests/test_zerodha_manual_recovery.py \
  backend/tests/test_stage09_connections_postgres.py
python - <<'PY_CHECK'
import xml.etree.ElementTree as ET
root = ET.parse('/tmp/stage09.xml').getroot()
assert not root.findall('.//testcase/skipped'), 'Stage09 cannot skip checks'
assert len(root.findall('.//testcase')) >= 34
PY_CHECK
```

The fake database username/password above belong solely to disposable test services. The fixture requires `/.dockerenv`, the exact database URL, schema create/drop rights and absence of root/backend `.env` files. Without acknowledgement, four PG tests skip, which the CI postcheck rejects. Native macOS does not meet this container guard. Docker CLI exists but daemon/service readiness was not tested; no service was started. **Missing evidence is an executed exact-head disposable-container job with 34 checks, no skips/failures.** Do not run Alembic natively, point these tests at UAT2, or reuse a shared database merely to bypass the guard.

## Safe publication and artifact plan — prepared, not executed

Read-only GitHub recheck found original draft PR1250 at fc4d513, based on `codex/stage08-module-preferences-20261020` at61ce447b. It was published after the earlier remote check reported no branch/commit/PR. Leave that original branch/PR untouched and coordinate the successor with parent before publication. Its CI/artifacts cannot be relabelled as successor evidence. A later read confirmed original [PR Checks39421490754](https://github.com/tarunxt/investment-engine/actions/runs/39421490754) has15 successful jobs, [baseline39421490792](https://github.com/tarunxt/investment-engine/actions/runs/39421490792) and [API migration39421490732](https://github.com/tarunxt/investment-engine/actions/runs/39421490732) also succeeded. Original PG job118623266744 logged27 passed/no skips, but checkout was PR merge commit `7c2e45a2ce59b132644f420b886bb727b40fd8ea`, not the exact head. This supports the unchanged implementation without satisfying the successor's exact-head34-test gate. Native bundle/verification metadata exists for fc4d513; no archive bytes were independently downloaded/audited in this successor phase. See evidence/stage09-original-remote-ci.json.

1. On phase authorization, confirm this unique branch's HEAD and clean tree; recheck accepted Stage08 base is still61ce447b and re-read triggers if any workflow/base changed. No forced reset, original-branch update or merge. If another successor exists, coordinate exact source before integration.
2. Publish only this new branch using `git push -u origin HEAD:refs/heads/codex/stage09-recovery-successor-20261020-task3`. Create a new **draft**, with base `codex/stage08-module-preferences-20261020`, head the unique successor, and describe this successor plus inherited Stage09 implementation. Do not merge. Do not push main, dispatch production workflows, or invoke scripts/release-prod.sh.
3. Branch push matches no production workflow: deploy.yml only auto-runs on push main; its manual path checks main. The two operational push workflows match only `fix/sports-ranking-live-validation` or `codex/fix-ranking-errors`, with their own file filters. Other operational workflows are manual-only. No workflow_run/pull_request_target/schedule hook was found. PR events run PR Checks, baseline and API migration jobs; they have read-only contents permissions and isolated services. PR Checks contains artifact/rollback **tests**, not an invocation of the production release script. Production workflow files remain unchanged.
4. Require new exact-head PR Checks including the Stage09 PG/no-skip job, Stage07 PG and private-ownership gates, baseline and API migration checks. PR jobs using default checkout test GitHub's merge ref; record the tested ref honestly. Stage09, native-package and existing explicit-head jobs pin the source head. Both merge compatibility and head-specific evidence matter; an older head's green result is insufficient.
5. Native job on Ubuntu24.04/Python3.12 builds `uat2-native-bundle-<HEAD_SHA>` and `uat2-native-verification-<HEAD_SHA>`, audits and downloads the complete bundle, and verifies offline dependency installation. Verify manifest/source stamp, GitHub ZIP digest, archive contents and receipt, retain before the one-day artifact expiry, and record all exact links/hashes. No deployment during this phase.
6. Only after successor review/CI/artifact gates and separate current-phase authorization may the sole executor check current UAT2 READY/resource identity/budget/stop/retention and use the existing controller. Existing US$10 allowance and21Oct2026 21:04:13IST stop are unchanged. Stage09 acceptance requires actual deployment, owner-private browser/negative checks and owner review. Platform-provider approval remains separate; fake approval is not provider evidence. Stage10 cannot start from local checks alone.

## Gate record

| Gate | Successor state |
| --- | --- |
| Stage08 prerequisite | Owner-accepted/live61ce447b; unchanged |
| Code / local contracts | Repair implemented;171 pass |
| Pre-fix independent source review | Completed onfc4d513; detailed findings retained |
| Independent successor review | Pending; implementer does not self-certify independence |
| PostgreSQL migration/concurrency | Prepared; not run |
| Exact successor CI / native artifact | Not run / not built |
| Publication / new PR | Not performed in this phase |
| Stage09 UAT2 deployment / verification / owner acceptance | Not performed / pending / pending |
| Platform-provider approval | Pending; no real credentials accessed |
| Stage10 / production | Not authorized |
