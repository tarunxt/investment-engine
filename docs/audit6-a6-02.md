# A6-02: Events and Threats failed reads

Status: fixed locally and verified with controlled synthetic sources; production acceptance remains with integration.

Base: `968ac9c16ca0f88df4c68732c13792787cc66e60` (verified `origin/main`).

## Contract and scope

The Events/Threats latest endpoints return `analysis: null` only after a successful read with no matching saved job. History endpoints return a bounded `history` list (limit 100); they do not return a global total. Portfolio overview returns `latest: null` for a successful empty result. API read failures reject. The frontend must not reinterpret a rejected or pending read as any of those successful empty responses.

The affected pages are India Events, US Events and US Threats. The shared scan-history dialog also serves other scan stages; its list, cost calculation, saved identities and destination rules are preserved.

## Changes

- A portfolio response is required before showing snapshot fields or missing-snapshot guidance. A missing response displays unknown availability.
- The latest-analysis read must succeed before showing no-scan guidance. An independently successful saved analysis remains rendered after portfolio failure.
- India status and portfolio reads publish independently, so status failure does not discard a successful portfolio response.
- History count and total known cost show loading/unknown during pending/failed reads, including failed refreshes with previously known rows. Successful empty history still displays zero runs and zero known cost.
- Previously loaded rows remain available with an explicit notice when refresh fails. Superseded requests cannot overwrite newer results, and unmounted history dialogs ignore late completions.
- Refresh and close controls have accessible names.

No backend, financial calculation, timestamp, saved record, configuration, provider, execution permission, action boundary or deployment changes.

## Verification

`node tests/events-threats-failed-read-browser.mjs`: 24 scenarios passed with real page/history components at 1180px and 390px. Fixtures cover initial loading, timeout, HTTP 502, independently retained saved analysis/portfolio, successful empty/populated recovery, an 81-row history, missing/zero/known cost rows, retained rows after failure, cached-empty failure, keyboard refresh/close, nested dialog Escape, exact run/job navigation, interrupted reopening, superseded responses and unmounting. All network requests outside the ephemeral local fixture server are blocked; none occurred and no browser page errors occurred. Scan controls, historical-cost lookup and event-table/markdown rendering are isolated fixtures; provider execution and external price reads are forbidden. Threat summary rendering is real and retains a synthetic saved insight.

`node --test tests/dashboard-snapshot-availability.test.mjs tests/runs-history-loading.test.mjs`: 26 passed.

`npx tsc --noEmit`: passed on changed tree and baseline.

Focused ESLint on all changed frontend source/test files: passed. `git diff --check`: passed.

Baseline comparison: `A6_02_BASELINE=968ac9c16ca0f88df4c68732c13792787cc66e60 node tests/events-threats-failed-read-browser.mjs` fails on the missing unknown snapshot state after a controlled portfolio timeout. Adding `A6_02_HISTORY_ONLY=1` fails immediately because the baseline displays `0 runs` and zero known cost while loading. These are expected baseline defects, not new failures.

Synthetic screenshots are generated in `/tmp/a6-02-evidence` (or `A6_02_EVIDENCE`): failed and retained history plus portfolio-timeout with saved output, at both widths. Pixel inspection covered the failed history on narrow viewport, US Events timeout on narrow viewport and US Threats timeout on desktop. These are fixture screenshots, not production screenshots.

## Evidence limitations and handoff

The source PDF could not be materialized through the supported Library helper: initial attempt and one bounded retry both returned `download failed`. Metadata returned current version 3 while the assignment referenced version 2. No report screenshot visual review or live browser acceptance is claimed. The supplied finding and source contracts support this state/provenance correction independently.

Integration should apply the local commit or private incremental Git bundle based on the exact base above, rerun the focused checks, and coordinate production acceptance with the separate release/runtime owners. No push, PR, merge or deployment was performed by this task.
