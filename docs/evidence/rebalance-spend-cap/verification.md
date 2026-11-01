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
  tests/test_recommendation_audit_recovery.py
```

Result: **134 passed**, no failures/skips. Eight dependency/deprecation warnings
were reported; none was an application failure. The cap suite contributes36
tests, including real PostgreSQL races for concurrent admission, concurrent first
scope binding, and duplicate settlement. Each uses a fresh random local schema;
the fixture rejects remote/non-test targets and never reads the application
DATABASE_URL as its target. The other98 tests cover existing mocked provider,
metering and recovery behavior.

Earlier isolated SQLite cap check:28 passed with the then-single PostgreSQL race
skipped; concurrency evidence comes from the final PostgreSQL run, not SQLite.
An initial test registry-import failure was corrected in the test fixture by
loading the canonical model catalog before ORM operations.

Python compilation and `git diff --check` pass. The Alembic revision is supplied
but was not executed against production or any external database. Metadata table
creation in the disposable schema verifies the actual model constraints.

Acceptance demonstrated:

- India and US have independent20INR scopes; new sequence numbers share them.
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
