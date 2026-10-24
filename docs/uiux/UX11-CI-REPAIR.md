# UX-11 local CI compatibility repair

Validation completed 24 October 2026, 16:48 UTC. Tested implementation:
`2ca8e81bca6bf9bdc7d164ec1f9d2af7cdf6f2e2`, based on public
`8df4d96b3a8a4bafc9a00464387ba9777e0db783`. A subsequent documentation-only
commit records this evidence. No application, authorization, worker, provider,
database schema, deployment or runtime configuration changed in this repair.

## Failed source evidence retained

[PR Checks 40111533661](https://github.com/tarunxt/investment-engine/actions/runs/40111533661)
finished with 50 successful and four failed jobs at public `8df4d96`.
The other three workflows passed; aggregate job outcome was 53 passed / four
failed. Those failures were not rerun, erased or described as successful.

- [Stage12](https://github.com/tarunxt/investment-engine/actions/runs/40111533661/job/120924104927):
  133 tests passed, then the obsolete expected count of 128 failed. The expected
  count is now 133; the PostgreSQL/no-skip gate remains mandatory.
- [Frontend regression](https://github.com/tarunxt/investment-engine/actions/runs/40111533661/job/120924105055):
  429 passed / one failed. Replace the obsolete fixed-button assertion with the
  actual sticky bar, document order, target containment, content spacing,
  keyboard clearance and retained disclosure/touch-target assertions.
- [Webpack/browser](https://github.com/tarunxt/investment-engine/actions/runs/40111533661/job/120924104875):
  compilation passed; the browser expected the former no-module heading. Require
  the core workspace and owned safety read, no optional cards/data requests, and
  the current eleven customer utility links. Preserve keyboard/viewport and
  preferences race/account-switch checks. Cost administration must remain absent
  without backend role admission, including for the synthetic admin identity.
- [Stage16 bindings](https://github.com/tarunxt/investment-engine/actions/runs/40111533661/job/120924105028):
  four assertions expected exactly three config fields. Explicitly retain the
  additive metadata contract: the three legacy safety fields keep their exact
  values, while all capability metadata is checked separately. Synthetic
  shortlist availability grants no order authority; discovery/combined remain
  unavailable. Additional tests deny synthetic capabilities for absent and
  nonsynthetic runtimes. Owner isolation/session cleanup and private no-store
  assertions remain in force.

## CI coverage and local verification

All ten `frontend/tests/ux*.test.mjs` files are now in the existing frontend CI
list. All nine `backend/tests/test_ux*.py` files are in a separate step of the
existing Stage16 job with an exact 90-case, no-skip/no-error gate. Inventory was
compared with actual files and YAML parsed successfully.

| Local check | Result |
| --- | --- |
| Full frontend CI regression list | 505 passed, zero skipped |
| Focused mobile and UX frontend checks | 77 passed, zero skipped; included above |
| UX backend plus scoped HTTP/connections | 106 passed, zero skipped; includes 90 UX cases |
| Stage12 existing suite | 129 passed, four PostgreSQL-only cases skipped; 133 collected |
| Webpack production compilation and TypeScript | Passed |
| Authenticated synthetic Chromium harness | All four required groups passed |
| Mobile profile utilities | All eleven Tab-reachable at 320/360/390/430 pixels; Activity/Security navigation passed; ungranted cost link absent |
| Bounded browser navigation | 12 completed, zero errors, concurrency three, p95 2.73 seconds under unchanged ten-second limit |
| Outgoing whitespace check | Passed |

Browser receipt binds the served build fingerprint to the tested implementation,
with build/source digests and explicit false full-release/hosted-verification
flags. Private receipts, screenshots, build outputs and synthetic databases are
excluded from the proposed publication. The owned browser/runtime processes
were closed; generated build stamping was restored after verification.

Two unsuccessful local setup attempts remain in private evidence: an in-memory
SQLite global URL was incompatible with the existing connection pool arguments
and stopped test collection; using the existing unreachable PostgreSQL import
configuration let the tests use their disposable SQLite fixtures. The first
build attempt was blocked during sandbox loopback-port reservation before
compilation. The approved isolated local retry succeeded. Neither is a product
failure or PostgreSQL verification result.

## Remaining gates

The repair is local and unpublished. Exact-repair CI, including the four actual
PostgreSQL cases and newly wired UX lists, still needs separately authorized
publication. No CI counts, size limits, owner/security guards or budgets were
relaxed. No new product defect was found by these checks.

This does not close the previously documented discovery/combined-mode,
executable-advisory, complete-privacy, accessibility/pilot or fresh hosted owner
acceptance gaps. Local Chromium with synthetic responses is not hosted owner
acceptance, a live integration test or production capacity proof. No merge,
deployment, real orders or live settings changes occurred.
