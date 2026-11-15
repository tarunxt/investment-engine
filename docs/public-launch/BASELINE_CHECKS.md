# Reproducing the Stage 01 baseline

Run from the isolated repository checkout. Do not source production environment files or start the application, workers, Beat, bots or brokers. All fixture email addresses use example.invalid; test Google claims are synthetic. No production users/data are read or changed.

## Source inventory

python3 scripts/public_launch/inventory.py regenerates entrypoints.json and ROUTE_MATRIX.md using AST/text only. python3 scripts/public_launch/inventory.py --check rejects stale output and unresolved registrations. It never imports the application. The JSON includes file hashes, local call sites and exact source lines; classifications are intended launch classes, not assertions of implemented security. Unmounted router alternatives are visible. Backend router includes, framework docs, Next route methods/pages/proxy, decorated workers, Beat task dictionaries, signal/lifecycle functions, background dispatch sites and export-named helpers are covered. Hidden registrations in third-party packages and runtime monkeypatching are outside static evidence.

## Isolated local tests

```sh
python3 -m venv .venv-stage01
.venv-stage01/bin/python -m pip install -r scripts/public_launch/requirements-test.txt -c backend/requirements.txt
PYTHONPATH=backend .venv-stage01/bin/python -m pytest -q scripts/public_launch
PYTHONPATH=backend DATABASE_URL=sqlite+aiosqlite:///:memory: REDIS_URL=redis://127.0.0.1:1/15 ENVIRONMENT=test AUTH_DISABLED=false .venv-stage01/bin/python -m pytest --noconftest -q backend/tests/test_google_signin.py
python3 scripts/public_launch/inventory.py --check
git diff --check
```

The scoped conftest.py creates separate userA/userB/admin ORM rows and profiles in in-memory SQLite. Network connect calls are denied for that scoped suite. The fake broker can preview synthetic accounts and cannot submit. No migration/schema change is introduced. SQLite tests do not establish PostgreSQL transaction/race behavior.

## PostgreSQL/Redis integration

Existing reproducible commands are in .github/workflows/pr-checks.yml and api-attempt-migration.yml. The recommendation-audit container job provisions disposable postgres:16 and redis:7, explicitly binds synthetic URLs/acknowledgements, and runs the listed integration/queue/outbox/migration tests. The workflow-audit concurrency job uses CREDX_AUDIT_TEST_DATABASE_URL plus CREDX_AUDIT_TEST_DATABASE_ACK=disposable-local-only. Copy only a disposable job/service definition into a fresh Compose project if running locally; do not aim these scripts at an existing database/Redis process. Alembic must run inside the backend/test container per AGENTS.md. Do not start a host service or use a Redis logical database as the only isolation boundary. Docker daemon is unavailable on the consuming Mac; these integration checks were not run locally.

## Browser

Existing package commands: cd frontend && npm ci && npm run lint; npx tsc --noEmit; node --test tests/*.test.mjs; npm run test:secure-auth-bff; npm run test:playwright-hardening. Inspect each browser script's origin and environment before running: it must target a newly isolated synthetic stack, with test-only sessions and fake integrations, never cred-x.in or the stopped UAT. Browser baseline acceptance must cover login, logout, account switch/cache/stream clearing, A/B/admin and BFF/direct-backend denial paths. No browser/live stack was launched in Stage 01; those outcomes are pending rather than pass claims.

## Baseline evidence limits

No live Google/broker/SMTP/Sheets calls, production population query, network stress test, deployment or migration is part of the Stage 01 checks. Existing source findings are recorded separately in DECISIONS.md. Fresh CI and UAT are separate evidence classes. The inventory and fixture tests are not exhaustive security certification.
