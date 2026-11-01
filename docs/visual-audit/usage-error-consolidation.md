# USAGE-ERROR-CONSOLIDATION

Route: `/console/profile/cost-drivers`. Baseline: `1089c6f1` (current origin/main on 1 November 2026).

The requested presentation already exists in `CostUsageProvider.tsx` (introduced by `0124b802`). Preserve it: one section heading, one monthly availability message, one Retry usage button, and one quiet API cost details link inside the working settings shell. The unavailable panel has no dashboard placeholder height and renders no invented zero total or raw timeout. No recovery-panel UI or financial logic change is necessary. A follow-up keyboard screenshot exposed pre-existing narrow settings navigation overflow; the shell navigation now wraps at narrow widths so focusing Security/Activity cannot scroll the recovery panel out of view. Desktop navigation remains stacked.

This branch extends the existing offline browser integration test to cover exactly 1180×757, plus 1440×900 and 390×844; repeated failure/retry; single message/action; compact panel bounds; and keyboard traversal between Retry usage and API cost details. Existing coverage includes loading, recovered loaded data, confirmed zero usage, unknown/partial summary, and stale comparison responses after month changes. All API data is local fixture data; the harness blocks writes and external requests.

## Preservation coverage

- Monthly scope and unknown-cost meaning: unchanged; tested before usage loads and with missing totals.
- Retry usage: unchanged read-only summary GET; tested with keyboard, repeated failure, and recovery.
- API cost details: unchanged `/console/apis` destination and keyboard access.
- Settings/account navigation: unchanged real settings component; shell presence tested. Full Next.js navigation/back behavior is outside the offline mocked-router harness.
- Currency, timestamps, calculations, current month selection, permissions, and execution safeguards: no runtime changes.
- Dialog/open-close: no dialog belongs to this unavailable panel. Optimization dialogs are unchanged.

## Evidence and limits

The PDF `CredX_Visual_Design_Simplicity_2026-11-01(1).pdf` (`libfile_e735fdf1e9f48191b47cf49a5af5b476`) and selection image `image(20261101-024935).png` (`libfile_0d924221bd9881918bf2e207ee2d05a9`) were resolved through the current Library materialization route. Its transfer helper returned `download failed` for both; neither file has readable local bytes. Pages 1–13, 97–100, 148 and their preservation-map images could not be inspected. Initial verification used the supplied assessment text and repository implementation. The coordinator subsequently supplied source-verified requirements and the complete text of pages 97–100 from a native reviewer who visually inspected rendered assessment page 97 and complete proposal page 100 and read maps 98–99. This worker reconciled the implementation against that native review; this worker did not directly view the PDF. No further transfer attempts were made. Direct common-page image inspection remains unavailable.

Browser screenshots are generated locally in `/tmp/cost-recovery-evidence` and copied to `/workspace/usage-error-evidence` (`failed-1180.png`, `success-1180.png`, and equivalent 1440/390 files). They use fixture values, not production data. No live refresh, provider job, account change, merge or deploy is performed. Integration and serial deployment belong to the coordinator.

## Local results

- `node scripts/cost-usage-recovery-playwright.mjs`: PASS at all three viewport sizes.
- `npx eslint scripts/cost-usage-recovery-playwright.mjs app/console/profile/layout.tsx app/console/profile/cost-drivers/CostUsageProvider.tsx`: PASS.
- `npx tsc --noEmit`: PASS.
- `node --test tests/trading-bots-navigation.test.mjs tests/fx-presentation.test.mjs`: 9 passed, 0 failed.
- `git diff --check`: PASS.

Shared-file integration note: `frontend/app/console/profile/layout.tsx` changes only navigation flex wrapping/gaps. Preserve any coordinator changes to this shell when integrating. No automated-rebalance files are changed.


## Native-review mapping reconciliation

The native review confirms that page 100 is one inventory diagram, not a request for a large table, extra tab, or empty dashboard. Existing neutral compact presentation is preserved. The following complete mapped inventory is checked in the browser harness or source readback:

| Mapped item | Result |
| --- | --- |
| Settings / Manage your account settings and preferences | Existing heading and description asserted |
| Usage and costs unavailable | Exactly one section heading asserted |
| We could not load usage for this month | Existing equivalent “We couldn’t” wording asserted in one paragraph |
| Costs are unknown until usage loads successfully | Exact clause asserted; no zero total on failure or partial data |
| Profile | Existing `/console/profile` target and keyboard focus asserted |
| Preferences | Existing `/console/profile/preferences` target and keyboard focus asserted |
| Platform Cost Drivers | Existing target, active styling, keyboard focus asserted |
| Security | Existing `/console/profile/security` target and keyboard focus asserted |
| Activity | Existing `/console/profile/activity` target and keyboard focus asserted |
| Retry Usage | One action; keyboard repeated failure/recovery; existing GET handler preserved |
| API cost details | Existing `/console/apis` target and keyboard traversal asserted |
| No zero-cost inference / no retry triggered | Audit sentence is absent from UI; unavailable costs never render zero; native review triggered no live retry; local fixture retry tests only |
| Successful monthly data / lower account states unobserved | Existing success components inspected; synthetic successful, empty and partial fixtures only; no inferred production data or calculation changes |

There is no automatic retry/new provider request, new tab, recovery-panel layout change, or backend-repair claim. The shared settings navigation receives only narrow wrapping to prevent keyboard-induced page overflow; this is verified by viewport bounds and document scroll-width assertions. Screenshots now include loading at all three sizes and empty/partial at 390px in addition to failure and success. All five existing navigation destinations remain keyboard-focusable, and all fit without horizontal page overflow. Full Next.js navigation/back behavior is still outside the mocked-router harness; this branch changes no navigation targets or routing handlers.
