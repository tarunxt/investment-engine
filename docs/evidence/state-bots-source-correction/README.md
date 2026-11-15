# Scoped correction: STATE-Bots-Status-UnknownVersusZero

Finding mapping: original State/Recovery report page 14, unknown versus zero
source-state acceptance, including lower/nested rendering on the scoped routes.
This closes fresh production QA gaps reported by the coordinator at 06:48–50 UTC
on 2026-11-01. It does not expand into unrelated audit findings.

Base: production main `1822d4d7` fetched before editing. Browser completion:
2026-11-01T06:56:22.342Z. Saved results have been read back and screenshots inspected.
All failures and data below are synthetic local fixtures. Original stored evidence
and preceding repair evidence are retained.

Changes:
- Settle the overview's exact transient loading note when all passive reads settle,
  including rejection/timeouts and cached initial loading notes. Preserve genuine
  loading while pending, cached notes/values, verified zeros and timestamps.
- Lower Bullpen Events Summary uses unknown dashes without a snapshot, labels
  saved snapshot time and freshness, and does not infer absent activity or direct
  the operator to start scans/investment. Verified empty snapshots retain zero.
- Missing-run stage timings and last-run/guardrail status stay unknown. Saved run
  evidence retains the existing timing and result behavior.
- LLM diagnostics without saved run/stage evidence show an explicit unknown
  explanation instead of invented 0 rows, 0/0 progress, counters or runtime.
  The unknown modal supports focused Close, Tab containment, Escape and return
  focus. Saved zero-run diagnostics still show their verified counters.

Verification:
- TypeScript: pass (`npx tsc --noEmit`).
- Focused overview tests: 11 passed, 0 failed.
- Overview/navigation/workflow/timers/stage-status/queued-stage3 suite: 50 tests,
  48 passed, 2 failed, 0 skipped. Both failures are the unchanged baseline Stage 1
  candidate/position fixture mismatches already documented in
  `../state-bots-unknown-zero/baseline-failures.txt`.
- Actual full TradingBotsOverviewPage: pending passive reads retain loading;
  three synthetic rejections clear loading in expanded Details.
- Actual full BullpenAiPageClient and dynamically loaded production components:
  failed source, saved verified-zero snapshot and cached snapshot history pass.
  The exact rejected defaults are checked: `No auto scan results yet`,
  `Run Scans and Invest Now above`, `No auto-run result yet`, `Not run yet`,
  `Not started`, and absent-source event counts masquerading as zero.
- Actual failed-source diagnostics and saved-zero diagnostics pass. Unknown
  modal focus/Tab/Escape/return-focus and 390px layout pass. Desktop evidence uses
  1180x757, device scale factor 1 and 100% browser zoom.
- The seven exercised API methods are pre-existing passive getters/state reads.
  They are replaced with synthetic promises; local /api requests receive
  synthetic 503 responses. Zero operational calls and zero browser errors.
- `git diff --check`: pass.

Reproduce from frontend using the existing temporary esbuild harness dependency:

```sh
STATE_BOTS_ESBUILD_PATH=/tmp/state-bots-tools/node_modules/esbuild node tests/state-bots-source-correction.browser.mjs
```

Next navigation/auth/dynamic boundaries and API dependencies are isolated;
production React components and Tailwind CSS are used. No live operational calls,
new polling, scans, provider refreshes, trades, worker changes or deployment occur.
Only the sole integrator may merge/deploy; no optional PR is requested here.
