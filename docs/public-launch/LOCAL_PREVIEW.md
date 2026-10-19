# Stage 01 localhost preview

This resumes implementation baseline `f25811dd792ff759164d1d4aa76e8ae3c53dc1cb` in a new isolated worktree/branch, `codex/stage01-preview-recovery-20261019`. Stage 01 establishes ledgers, inventory and fixtures; it introduces no production UI or tenant/module behavior. The preview runs the existing Next.js production build, real Auth.js/BFF and existing FastAPI auth/profile handlers. It is not a replacement static frontend.

## Current Mac session

Canonical URL: http://localhost:54987/login?redirectTo=/console/profile/preferences . Use `localhost` consistently: the current baseline's Auth.js callback canonicalizes local redirects to localhost, so starting on 127.0.0.1 can lose the host-scoped session during redirect.

Frontend: 127.0.0.1:54987, PID/process group 58613. Synthetic backend: 127.0.0.1:54988, PID/process group 58612. No PostgreSQL, Redis, worker, Beat or broker process is started. Logs, state, database and token-free smoke evidence live under `.runtime/stage01-preview/` in this worktree, outside Git. The original task-2 and UAT2 task-3 files/processes are preserved.

Sign in with `usera@stage01.example.com`, `userb@stage01.example.com`, or `admin@stage01.example.com`; synthetic password for all three: `SyntheticPreview123!`. These reserved example-domain identities are not real users. The original in-memory baseline fixtures still use example.invalid; interactive login uses a reserved example.com subdomain because EmailStr rejects .invalid input.

## Start, inspect and stop

Run from `/Users/tarunsingh/Documents/Codex/2026-10-19/task-5/investment-engine`:

```sh
# Existing session: inspect without starting anything else.
.venv-preview/bin/python scripts/public_launch/preview.py status
# Only when finished reviewing this task's preview:
.venv-preview/bin/python scripts/public_launch/preview.py stop
# Start again after stop; selects unused loopback ports and prints the new URL/PIDs.
.venv-preview/bin/python scripts/public_launch/preview.py start
# Repeat the bounded API/BFF checks against that exact running preview.
.venv-preview/bin/python scripts/public_launch/verify_preview.py
```

For a fresh checkout, create `.venv-preview`, install `backend/requirements.txt`, `aiosqlite==0.22.1`, and the existing `scripts/public_launch/requirements-test.txt` constrained by `backend/requirements.txt`. Install frontend dependencies from its package-lock with `npm ci`. Set `STAGE01_NODE` to an installed Node executable if it is not on PATH; the launcher can also find the bundled Codex runtime on this Mac. Then run `.venv-preview/bin/python scripts/public_launch/preview.py build` before `start`. The tested build used Next 16.2.5/Webpack. Production mode matters: existing development mode bypasses client auth and causes a login/console redirect loop. This harness does not repair or change that application behavior.

The launcher refuses application .env files in the root/frontend and builds a fresh synthetic environment instead of inheriting integration credentials. It never opens Docker. The stop command verifies recorded process start time and command before targeting this worktree's process groups; it refuses stale/reused PIDs. Do not manually transfer a state file between sessions. Stopping retains the disposable synthetic database and logs.

## Review steps and visible scope

1. Sign in as A; view Settings > Preferences and the Profile screen. Change timezone or theme, save, reload and verify persistence.
2. Sign out, sign in as B, and verify B has its own unchanged preferences/profile. Repeat with the synthetic admin to verify its role is preserved.
3. Sign out and revisit preferences: the existing auth boundary returns to login. Google sign-in is visibly unconfigured in this preview.
4. Other navigation still shows the existing product, but routes beyond the auth/profile allowlist return an explicit synthetic-preview unavailable response. Do not interpret dashboard/provider errors as working integrations.

The preview adds no Stage 02 tenant controls, module changes, conditional fallbacks, real Google OAuth, email delivery, AI execution, order submission, bot starts or exports. Integration behavior is faked by fail-closed unavailable responses; Python outbound sockets are denied and frontend server connections are restricted to the two loopback preview ports. The real auth/profile routes and SQLAlchemy persistence remain active. SQLite tables are created only in this preview file; no Alembic/production migration is run.

## Verified evidence and limitations

The existing 5 baseline and 19 Google-login tests pass again. The real frontend production build including TypeScript passes. The bounded running-stack smoke has 42 passing checks: three users/roles, unique IDs, real auth, A preference persistence with B unchanged, invalid/anonymous denial, Auth.js/BFF identity and hidden bearer tokens, authenticated preferences HTML, profile reads, logout/session clearing, and blocked external action paths. `evidence/preview-api-checks-20261019.json` contains token-free results.

Browser verification is tracked separately in STATUS.md. API/BFF HTML checks do not substitute for browser interaction.

Docker was rechecked in this recovery and remained unavailable: both normal socket paths were absent, and launcher attempts did not produce a usable daemon. No containers were launched by this task. No further Docker launch attempts are part of this preview. The UAT2 task's separate disposable Docker smoke is separate evidence, not a Stage01 PostgreSQL/Redis result. SQLite does not establish PostgreSQL types, transaction/race behavior, Redis queues, worker scheduling, migrations, stream isolation, UAT admission/TLS/Google callbacks or provider approval. Stage 00 live acceptance remains BLOCKED and no UAT/production deployment or merge is authorized.
