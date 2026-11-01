STATE-Bots-Page-ErrorRecovery

Baseline fetched 2026-11-01 UTC: origin/main 8212f9e93772a8f5a91f3f782640aeeff0fe7cc8.
Verification completed 2026-11-01T06:20:49Z.

The Copy and Direct pages now identify their failed bot state read, explain that current data could not be checked, expose raw diagnostic text behind keyboard-accessible details, and provide an ordinary /console link. Later failures retain the existing snapshot and label it as possibly out of date. No retry, API, polling, trading, worker, schedule, account, formula or security changes.

Validation:
- node --test tests/polymarket-bot-passive-read.test.mjs: 15 passed, 0 failed, 0 skipped. Actual page rendering with synthetic hook/module fixtures covers loading, populated runtime metrics, verified-empty success, initial error and later read failure for both routes; existing passive-read effect coverage retained.
- node scripts/bot-state-recovery-offline-playwright.mjs: 4 passed, 0 failed. Actual shared recovery component for both page identities with initial/partial fixtures; 1440x900 deviceScaleFactor 1 desktop screenshots, 390x844 narrow screenshots, keyboard link focus/details activation, no horizontal overflow, /console navigation and browser back. Zero external requests or browser errors.
- Scoped ESLint: passed, 0 warnings/errors.
- npx tsc --noEmit: passed.
- git diff --check: passed.

Readback: browser-result.json read from disk; copy-error-desktop100.png and direct-partial-narrow.png opened and visually inspected after saving. Eight PNGs are synthetic local evidence, not production screenshots. Source PDF pixels were not needed for this text/error-state repair; complete scoped report was supplied by coordinator.

Limitations: full Next page/shell integration browser coverage and live production checks were not run. Browser harness mounts the actual shared recovery component; full-page state coverage uses Node fixtures with stubbed decorative/deferred components. No production failure manufactured. No merge/deployment performed: reserved to batch integrator.
