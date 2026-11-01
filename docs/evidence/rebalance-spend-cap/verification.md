# Local verification: Rebalance spending admission

Base: `da317a1097cef97089e3a745b9e20b4952af6a48`.
Branch: `audit7/rebalance-spend-cap-20261101`.

All fixtures are synthetic. No production database, account, provider, order,
export or mail operation was used. Temporary dependencies and PostgreSQL17 were
installed/extracted under `/tmp`; repository dependencies/settings were unchanged.

Combined command, from backend (the local test URL is illustrative only):

```
CREDX_CAP_TEST_DATABASE_URL=postgresql://localhost:55439/credx_cap_test_local \
CREDX_CAP_TEST_DATABASE_ACK=disposable-local-only PYTHONPATH=. \
python -m pytest -q -o addopts='' \
  tests/rebalance_budget tests/test_api_usage_attempts.py \
  tests/test_deepseek_provider.py tests/test_openai_provider.py \
  tests/test_recommendation_audit_recovery.py tests/test_auto_rebalance_run_sequence.py
```

Result: **150 passed**, no failures/skips. Twelve dependency/deprecation warnings
were reported; none was an application failure. The cap suite contributes48
tests, including real PostgreSQL races for concurrent admission, concurrent first
scope binding, and duplicate settlement. Each uses a fresh random local schema;
the fixture rejects remote/non-test targets and never reads the application
DATABASE_URL as its target. The other102 tests cover existing mocked provider,
metering and recovery behavior.

Earlier isolated SQLite cap check:28 passed with the then-single PostgreSQL race
skipped; concurrency evidence comes from the final PostgreSQL run, not SQLite.
An initial test registry-import failure was corrected in the test fixture by
loading the canonical model catalog before ORM operations.

Python compilation and `git diff --check` pass. The Alembic revision is supplied
but was not executed against production or any external database. Metadata table
creation in the disposable schema verifies the actual model constraints.

Acceptance demonstrated:

- Each explicitly authorized logical market workflow has its own20INR scope.
  Retries replay the original authorization; explicit continuation sequences share
  that scope, while a genuinely new authorized workflow gets a separate grant.
- Exact Decimal admission and upward rounding never free a fractional allowance.
- Unknown tariffs/FX/fees/request bounds cause zero mocked upstream calls.
- The real worker installs and resets the cap context; denial does not retry.
- Model calls, streamed-call contexts and search helpers use the common gate.
- Search denial cannot silently fall back or become model tool text.
- Scope/job ownership is checked before reservation.
- Replayed/uncertain requests do not acquire fresh spending permission.
- Missing receipts, timeout, malformed settlement and unpriced usage retain spend.
- Duplicate settlement counts once; a bound breach records actual and freezes.
- Unrelated untagged jobs and existing recovery containment regressions pass.

Limit: **no live adapter is certified**. The production resolver intentionally
blocks them all. A reviewed reliable bound and settlement policy is required before
an adapter may dispatch. This evidence does not prove an external invoice ceiling
or a successful paid Rebalance workflow, and it must not be described that way.

## Integration review correction

The initial local commit used owner/market uniqueness, which would have made the
allowance lifetime-scoped. It was not deployed. The corrected model uses an explicit
authorization UUID and supports multiple logical workflows for the same market.
The existing label route now requires New/Continue intent; it rejects an old
`{portfolio}`-only request before Redis label reservation. Tests exercise that
handler plus new-grant/replay/continuation behavior without network access.

The native UI now sends explicit consent, stable UUID, server revision and
continuation scope. Read-only readiness returns owned allowances and a clear
adapter-unavailable explanation. UUID replay reconciles without restarting stages.
A PostgreSQL race verifies that two different stale request UUIDs cannot mint two
new grants; the original UUID remains replayable despite a stale revision.

The actual React component and authorization module passed an isolated Chromium
fixture with a local synthetic API: New/Continue, duplicate clicks, navigation,
reload, uncertain responses, concurrent tabs, missing Web Locks and unavailable
adapters. External requests were blocked by the browser route guard. The UI fixture
uses synthetic readiness=true only to exercise the prospective consent lifecycle;
the real backend always reports live paid execution unavailable. This is not
provider feasibility or live-run evidence.

The authorization module passes strict TypeScript checking; all changed TS/TSX
files pass transpile diagnostics. Full Next build/component type checking could
not run: offline npm cache lacks required packages (first missing zwitch), React
type declarations and Next's bundled documentation are absent. No external package
fetch was attempted. Only React/browser APIs were added; no Next API was changed.
The integrator must run its full frontend build/type/lint checks after merging.

Live adapters remain uncertified. Normal full Run remains unavailable under this
fail-closed patch, with a visible explanation rather than an unexplained422.
The independent F08 mail/export policy must be integrated by its owner. No paid
calls, side effects, production changes, push, PR or deployment were performed.
