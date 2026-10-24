# Local CI repair and measured login reduction

Product repair source:5825ffa571bac0deec66a94c5991d83171d66e7b, descending from
preserved privacy-policy successor24ccbe5. No successor was published or deployed.

## Repairs

- PostgreSQL fixture test_pg_recoverable_erasure_roundtrip_is_atomic_and_owned
  now selects QuarantinedFixturePrivacy with its explicit disposable reference.
  Restored owner API keys must be inactive; foreign keys remain active, history
  remains owned and replay is idempotent. Generic credential recovery remains
  excluded. The existing SQLite quarantine fixture now includes actual APIKey
  models and verifies inactivity, foreign-owner preservation and audit rollback.
- Only acquisition-journal expected count changes13to11. The native-order13,
  privacy57 and policy39 gates are unchanged; no test was removed or skipped.
- Login uses semantic escaped error markup and a CSS pending spinner instead of
  importing the generic icon alert and spinner. Error title/message/details,
  dismissal, pending-submit protection and Google/password flows are retained.
  No provider/auth contract, dependency version, budget or baseline was changed.

## Measurements and tests

The standalone webpack build and actual packaged runtime/auth/proxy/route/asset
gate passed. Before: exact267b476 CI measured195079 transferred bytes and623169
decoded bytes in11 login files. After: local5825ffa measured192997 transferred
and618310 decoded bytes in10 files. This is2082 fewer transferred bytes and1102
bytes below the unchanged194099-byte relative ceiling. The before run was Linux
CI/Node22; after was local macOS/Node24. The measurements are not claimed to be a
controlled same-platform comparison; exact-source Linux CI remains required.

The original reference176454/567671, ten-percent growth rule and fixed
250000/700000 caps remain intact. The budget script SHA256 is
6a06802cca34aedde1198f5237e8083ea8a26449f1f8a190f02ed0ec0debe67e.
Dashboard177799/573703, Bullpen223061/728094 and automated-rebalance636413/2011645
also passed their existing packaged-runtime budgets (transferred/decoded).

The existing Chromium auth/rendering gate passed, including new rejected-login
feedback, disabled pending-submit and dismissal assertions. The dismissal
locator explicitly excludes Next's persistent route-announcer alert. All four
existing receipt groups passed. Its bounded browser-load subset completed12
navigations, zero errors, peak concurrency3, p95approximately0.46seconds; this is
synthetic frontend navigation evidence, not backend or production capacity.

18 acquisition/base-key-denial/quarantine tests passed, zero skips. Six dependent
financial-recovery tests and six source baseline checks passed, zero skips.
These counts are distinct focused runs, not additions to the historical suites.
The PostgreSQL module collects five cases; no PostgreSQL case ran locally because
Docker, psql and redis-server executables are unavailable. The repaired actual
PostgreSQL fixture still requires acknowledged disposable PostgreSQL CI and its
42-case/no-skips gate. Do not count collection as execution.

The browser harness correction and stronger SQLite assertions follow the product
repair; all application source remains identical to5825ffa. Build metadata was
stamped for validation and restored afterward. Raw logs, screenshots, packaged
artifact and synthetic databases remain local; public evidence is a sanitized
projection only. No actual user data, live setting or security control changed.

## Linked rendered acceptance and actual restart

The existing linked-browser gate passed on the same product source with explicit
synthetic SQLite/backend workers, actual password login and two owners. It
verified exact approval, partial execution before/after process restart, cancelled
disable versus actual disable/history, durable accepted-unknown evidence and
restart reconciliation to filled with one venue submission/attempt per intent.
Unknown capture is read-only durable-store evidence, not a claimed screenshot of
the transient state. Seven screenshots were retained locally; only their names
and hashes enter the sanitized receipt. Owner/egress/no-replay guards are intact.

An initial linked run showed read-timeout UI immediately after restart. The test
now waits using bounded authenticated GETs (no redirects), then explicitly uses
the documented Refresh action; approval/dispatch are never retried. A second
attempt correctly failed its fingerprint guard because build metadata was
restored too early; no workflow ran in that attempt. Correct metadata was set
before the final fresh build. The final linked run passed and its owned processes
stopped; all synthetic failed fixtures/evidence are preserved locally. Application
timeouts, size limits and live runtime settings were not relaxed.

The sanitized evidence file is evidence/ci-repair-5825ffa-local.json. It records
product source, harness hashes, package hash, measurements and explicit non-hosted
limits. Actual PostgreSQL verification and complete exact-source CI remain
pending publication approval. This local result does not change the old failed
267b476 workflow conclusion or authorize deployment.
