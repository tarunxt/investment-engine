# A9-R12 — exact original-suite execution record

Application source tested: `00a404e926afffc8401eec849fc494697e6e881d`; baseline `8d25f34a33242adcaab092afdb07af7956f327bd`. Original test files were not rewritten or replaced by adapted runners. New Audit9 fixtures are reported separately. No merged candidate or deployed-runtime equivalence is claimed.

Environment: Python 3.12 isolated `/tmp/privacy-audit-venv` using repository requirement pins plus pytest 9.2.0, pytest-asyncio 1.4.1.post1, aiosqlite 0.22.1 and fakeredis 2.40.0; Node 24.19.0, TypeScript 5.9.3, installed using unchanged npm lock. Python test commands run from repository root with the prefix `env -i PATH=/tmp/privacy-audit-venv/bin:/usr/bin:/bin PYTHONPATH=backend python -m pytest`; no inherited operational environment is used. Repository conftest supplies synthetic provider identifiers and disables telemetry persistence. Node commands below run from `frontend/`.

| Exact command after Python prefix, or full Node command | Pass | Fail | Skip | Exit |
| --- | ---: | ---: | ---: | ---: |
| `-q backend/tests/test_output_contracts.py` | 97 | 0 | 0 | 0 |
| `-q backend/tests/test_rebalance_side_effect_policy.py backend/tests/test_auto_rebalance_audit_durability.py` | 135 | 0 | 0 | 0 |
| `-q backend/tests/test_google_sheets_output_contracts.py backend/tests/test_output_runtime.py backend/tests/test_auth_websocket_tickets.py` | 47 | 0 | 0 | 0 |
| `-q backend/tests/test_output_source_context.py backend/tests/test_output_consistency.py backend/tests/test_output_provenance.py backend/tests/test_output_runtime_cancellation.py backend/tests/test_rebalance_side_effect_policy_migration.py` | 94 | 0 | 0 | 0 |
| `-q -rs backend/tests/test_output_source_context_postgres.py backend/tests/test_rebalance_side_effect_policy_postgres.py` | 5 | 0 | 12 | 0 |
| `node --test tests/database-viewer-owner.test.mjs` | 5 | 0 | 0 | 0 |
| `node --test tests/private-dashboard-cache.test.mjs` | 2 | 0 | 0 | 0 |
| `node --test tests/auth-session-cookie.test.mjs tests/bullpen-server-auth.test.mjs tests/rebalance-side-effect-policy.test.mjs` | 21 | 0 | 0 | 0 |

T01: original database-viewer owner suite includes its actual route-orchestration test, and the original TypeScript private-cache suite executes unchanged using installed TypeScript. T02: all 97 original output-contract tests run, including `test_contract_columns_match_frontend_exactly`; no source/frontend agreement test was omitted. T03 partial: SQLite-backed owner/workflow/side-effect transactions, mocked provider/export workers, session-cookie helpers and fake-Redis one-use WebSocket tickets execute. This is not complete live-stack API/BFF/session/worker/WebSocket integration.

PostgreSQL: 11 original source-context integration cases skip because no explicitly acknowledged disposable local database target is configured; the policy migration case skips because its explicit disposable PostgreSQL target is absent. Five unsafe-target guard fixtures pass. No database service, account or redundant infrastructure was created.

Original BFF script attempt, from frontend: `env -i PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin node scripts/verify-secure-auth-bff.mjs`. Exit 13, zero verified integration assertions, warning about unsettled top-level await at script line 130. `frontend/.next/BUILD_ID` is absent. The script's cleanup does not expose a more precise startup cause; do not call this a passing BFF test. A supported isolated production build and corrected/working harness must be supplied through the existing coordinator before full BFF integration can be established. The test uses only ephemeral loopback mock servers and a synthetic signed session; no production identity or credential was used.

Setup evidence: initial `npm ci --ignore-scripts --no-audit --fund=false` exited 254 because the default cache `/home/agent/.npm/_cacache` was absent/unwritable; this was a local filesystem setup error, not a permission-review or network denial. Same npm lock install with `--cache /tmp/privacy-npm-cache` succeeded (844 packages); no package version changes or alternate registry were used. Python dependency install succeeded in the isolated venv. Warnings from pytest/AnyIO, crypt and SQLAlchemy deprecated UTC helpers remain; no test failure is hidden by them.

T04: exact commands, source identity, counts and blockers above replace any inherited broad pass total for this scope. Complete integration remains open, as do acceptance gates in A9-R02/R05/R09. No PR, issue, publication, deployment, production probe, real export or paid call was attempted.
