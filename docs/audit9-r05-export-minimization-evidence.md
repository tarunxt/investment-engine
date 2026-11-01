# A9-R05 — synthetic projection/export and no-dispatch evidence

Application source revision: `00a404e926afffc8401eec849fc494697e6e881d`; reviewed 2026-11-01. This supplements logging redaction with actual serialization/export tests. It does not change the Audit7-owned output/export contracts, API projections, provider configuration, stored originals or auth. A9-002 rightful-actor remediation remains a dependency; baseline direct Job GET does not provide owner-filter evidence.

New isolated fixture suite: `backend/tests/test_audit9_export_minimization_evidence.py`.

* JobResponse excludes undeclared access-token, refresh-token, password-hash and owner attributes while retaining intended prompt/result fields.
* Canonical export keeps all 31 financial columns and source symbol meaning; unsupported credential metadata prevents canonical export.
* The actual export Celery task with mocked storage/append excludes unrelated credential/context attributes from the captured append payload. All credential decryption and remote append behavior in this path are mocked with synthetic values.
* A real synthetic SQLite transaction verifies that the actual worker rejects user 8 requesting user 7's job before credential access or append. Existing synthetic users are reused; socket connects and email dispatch are blocked by the fixture.
* Five strict expected-failure cases deliberately retain unmet acceptance: declared `error_message`, `export_error`, `runtime_metadata_json` and `request_context_json` can serialize a synthetic sensitive sentinel; an ancillary table containing a sensitive sentinel survives source-preserving export. Each xfail is restricted to AssertionError and becomes an XPASS failure if the gap is fixed. None is counted as passing minimization.

T01 partial: intended projection and worker ownership boundaries have bounded evidence; whole API actor isolation awaits A9-002. T02 not met overall: four declared-field projections and ancillary export still require an approved minimization/preservation contract and the owning implementation lane. Do not silently erase original financial evidence to satisfy this test. There is no claim that real records contain credentials.

T03: original `test_rebalance_side_effect_policy.py` executes actual analysis-only run creation, repeated workflow email paths and actual job/run export workers with synthetic SQLite. The tests assert suppression before credential access and no dispatch, including repeated attempts. The combined original policy/owner durability command passed 135 tests, 0 skip/fail. This proves tested paths, not every external-dispatch path in the application.

New suite final result: 4 passed, 5 xfailed, 0 unexpected failures. Initial development run had one fixture assertion expecting `exported`; the actual supported worker status is `completed`; fixture corrected with no runtime change. Original mocked Sheets/output-runtime/WebSocket suite passed 47 tests. Exact commands and remaining integration gates are recorded under A9-R12. No actual spreadsheet, email, provider execution, secret read or private record was used. Overall recommendation remains open.
