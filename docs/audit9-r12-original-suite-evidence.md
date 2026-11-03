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

## Follow-up: production build and repaired original BFF fixture

At application source `62829a2441c4a9b2fded72571568673485dee39b` (tests/docs-only delta from the application revision above), the isolated production build now succeeds. Command from `frontend/`:

```sh
env -i PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXTAUTH_SECRET=synthetic-audit9-build-sentinel AUTH_SECRET=synthetic-audit9-build-sentinel NEXTAUTH_URL=http://127.0.0.1:3000 NEXT_PUBLIC_FRONTEND_URL=http://127.0.0.1:3000 NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 BACKEND_API_URL=http://127.0.0.1:8000 npm run build
```

Exit 0: webpack compile, TypeScript checks, 49 static pages, build traces and the original postbuild runtime artifact verifier completed. `.next/BUILD_ID` exists. An initial dashboard summary was unavailable against the intentionally empty local mock address; no operational service or real account was queried. No local environment files were present and no inherited operational environment was used. Next 16.2.5, Node 24.19.0 and unchanged dependency lock apply.

The original `scripts/verify-secure-auth-bff.mjs` had a cleanup event race: it subscribed to exit/close events after requesting shutdown and could await an event that had already happened. Only teardown was repaired to subscribe before shutdown and recognize an already-exited child. Its original session encoding, request and assertions remain unchanged. No auth configuration or application transport was changed.

Rerun from frontend: `env -i PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin node scripts/verify-secure-auth-bff.mjs` — exit 0, one original integration scenario passed: three terminal acceptance assertions (HTTP 200, exact body, exact mocked backend authorization/path), plus two original address setup assertions. Zero failed/skipped acceptance assertions. Output: `Secure Auth.js session reached the protected backend proxy.` This supersedes the earlier exit-13/zero-assertion BFF outcome for this candidate only.

Additional native-browser command: same clean PATH prefix followed by `node scripts/audit9-browser-origin-evidence.mjs` — exit 0, five cases passed, zero failures/skips, installed Chromium 154.0.8037.57. This is a separate fixture, not a replacement for any original suite. All frontend/backend/alternate-site endpoints are ephemeral loopback mocks and all session values synthetic. External browser requests are blocked.

PostgreSQL availability follow-up: `docker ps --format '{{.Names}} {{.Image}}'` and `docker images --format '{{.Repository}}:{{.Tag}}'` both exit 0 with empty output; no native postgres/pg_ctl/psql executable is available. No existing official 18.6 fixture is reachable/discoverable in this executor. No image download, new database infrastructure, test account or production fallback was attempted. The previous 5 guard passes / 12 integration skips remain current; coordinator must supply the existing isolated fixture route before these gates can run. Complete cross-stack/PG integration and auth-release acceptance remain open.
