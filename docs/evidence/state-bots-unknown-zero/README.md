# STATE-Bots-Status-UnknownVersusZero

Implementation based on fetched main `8212f9e93772a8f5a91f3f782640aeeff0fe7cc8`.
Verification performed 2026-11-01 UTC; exact browser completion time is saved in
`browser-result.json`. All screenshots are isolated synthetic fixtures, never
production failures or live account evidence.

Changes:
- Unavailable/placeholder runtime sources leave overview runtime totals unknown.
  Reported zero totals remain zero. Cached card values identify snapshot source
  and overview timestamp; underlying observation age is explicitly unknown.
- No Bullpen saved run means unknown execution and stage labels, with no queue
  assertion, zero coverage or completed coverage bar. Trigger absence is unknown.
- Saved run status identifies the run and recorded start/completion time while
  qualifying current worker execution as unverified.
- The canonical Bullpen portfolio masks position, claim, trade and confirmation
  counts without their relevant source. Reported counts retain source and age
  qualification. Numerical calculations and stored evidence are unchanged.

Verification:
- `npx tsc --noEmit`: pass.
- Focused passive overview tests: 10 pass, 0 fail.
- Combined overview/navigation/workflow/stage-status/queued-stage3/verified-
  portfolio tests: 62 tests, 60 pass, 2 fail, 0 skipped. The two Stage 1 legacy
  fixture mismatches reproduce on unmodified main: extra nullable candidate
  fields and `returnsPerDay: null`. They are not changed by this repair.
- Actual React TradingBotCard and full BullpenAutoRunScheduleCard, production UI
  components and generated production Tailwind CSS: eight fixtures pass
  (loading, success-zero, populated, failed, partial, stale-response, queued,
  running), 1180x757 desktop at 100%, 390x844 narrow, no horizontal overflow,
  keyboard Enter/Tab and actual Details expansion. All API dependencies are
  replaced with synthetic getters; network positions reads receive synthetic
  503 responses. Operational API calls are forbidden; none occurred.
- Passive overview retry tests run with both fulfilled and rejected reads and
  reject all APIs except the three pre-existing passive overview getters.
- `git diff --check`: pass.

Reproduce browser evidence from `frontend/` after `npm ci`:

```sh
npm install --prefix /tmp/state-bots-tools --cache /tmp/state-bots-npm esbuild
STATE_BOTS_ESBUILD_PATH=/tmp/state-bots-tools/node_modules/esbuild node tests/state-bots-status.browser.mjs
```

The browser uses `/usr/bin/chromium`; esbuild is a temporary harness dependency,
not a production dependency. Next navigation/auth/dynamic boundaries are mocked.
The actual Bullpen schedule is rendered without authenticated production data.
Queued/running fixture workflow text comes from the actual workflow view builder;
this does not establish worker execution. No production scans, refreshes, trades,
connections, worker changes or deployments were run. The original audit PDF and
stored source evidence were not modified. Final integration/deployment belongs
to the sole batch integrator.
