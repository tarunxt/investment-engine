# Stage06 review checkpoint

This resumes the owner-accepted Stage05 baseline10c5a2c1561e8d1cf0e5b54c5b53e89e0c564c95 on isolated branch `codex/stage06-module-policy-20261020`. Stage01–05 history and worktrees are preserved. No Stage07 implementation or production deployment is included.

Implemented: ten canonical IDs, immutable registry validation, typed versioned configuration, additive owner-bound selection tables, atomic optimistic concurrency, virtual unselected defaults, authenticated GET/PATCH `/me/modules`, read-only POST `/me/modules/disable-impact`, shared HTTP/stream/worker/effect policy interfaces and internal-analysis capability contract. Selection cannot provide an entitlement, connection, execution authority or confirmation. Unknown server facts deny optional operations; core account capabilities remain independent. Google onboarding retains its existing transaction and has no optional records or copied preferences by default.

Remaining enforcement is explicit in STAGE06_INTEGRATION_LEDGER.md. `operational_enforcement_complete=false` describes this limit. Optional UAT2 modules remain unavailable; only management routes are added, under unchanged active exact-owner authentication. No existing singleton runtime or broker route is enabled. The new migration creates two empty tables, changes no legacy row/role/grant, and never blanket-enables users.

Verified locally:

- 1,213 existing PR backend release-selection tests passed.
- 104 affected API, Google, Stage05, UAT2 and baseline tests passed.
- 110 ownership/live-boundary/module regression tests passed.
- Seven actual disposable PostgreSQL checks passed, including first-writer and existing-version races, mixed-patch atomicity, concurrent and failed Google onboarding, all-prior-table migration preservation/roundtrip, and response-failure rollback after flushed changes.
- Real Next production Webpack build and TypeScript checks passed.
- Eleven real localhost Auth.js/BFF/FastAPI module checks passed: active identity, two-owner isolation, atomic patch, stale409, ten registry entries, disable preview, authority injection rejection and denied execution. Synthetic selection was restored afterward.

A test exposed SQLite's first-SAVEPOINT release committing the version header prematurely; the service now uses a dialect-specific SQLAlchemy INSERT ON CONFLICT CAS in the outer transaction. Both SQLite and PostgreSQL post-flush rollback tests pass. An initial migration comparison included an existing table omitted by its baseline helper; comparison now explicitly includes every prior table. An initial broad invocation lacked PYTHONPATH and failed collection; the documented corrected invocation passed. No failed check is counted as passed or waived.

## Runnable Mac preview

URL: http://localhost:60473/login?redirectTo=/console/profile/preferences
API: http://127.0.0.1:60474
Backend PID15870, frontend PID15871. State/verified process stamps: `.runtime/stage01-preview/state.json`.

From this worktree:

```sh
.runtime/python/bin/python scripts/public_launch/preview.py status
.runtime/python/bin/python scripts/public_launch/preview.py stop
.runtime/python/bin/python scripts/public_launch/preview.py start
.runtime/python/bin/python scripts/public_launch/check_stage06_preview.py
```

If a recorded port becomes occupied, run `build` before `start` to choose fresh ports and rebuild compiled URLs. Stop verifies process stamps and targets only this preview; earlier previews remain untouched. Logs and isolated SQLite file are under `.runtime/stage01-preview/`.

Sign in with `usera@stage01.example.com` or `userb@stage01.example.com`, password `SyntheticPreview123!`. Existing Preferences, Jobs and Runs remain real application screens. Stage06 adds the backend contract; module-selection screens belong to07. The authenticated BFF endpoint `/backend-api/me/modules` shows separate selection, availability, entitlement, connection and execution axes. The supplied protocol script exercises PATCH and disable impact without a fabricated frontend.

Backend outbound socket connections are denied, all users/data are synthetic, fake consumer and offline catalogue/cost/health adapters remain. No provider, email, order, paid AI, AWS or production data/action is used. SQLite preview is distinct from the separately verified disposable PostgreSQL tests and is not live UAT acceptance.

Pending at this checkpoint: exact-commit CI/native artifact verification, mandatory independent review, coordinated Mac-browser walkthrough, sole-executor UAT2 handoff and new owner acceptance. No old CI/artifact/browser identity is transferred to06. Existing US$10 total and21Oct2026 21:04:13IST stop remain unchanged. No new access/role/credential approval is requested or implied.
