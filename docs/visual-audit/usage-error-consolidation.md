# USAGE-ERROR-CONSOLIDATION

Route: `/console/profile/cost-drivers`. Baseline: `1089c6f1` (current origin/main on 1 November 2026).

The requested presentation already exists in `CostUsageProvider.tsx` (introduced by `0124b802`). Preserve it: one section heading, one monthly availability message, one Retry usage button, and one quiet API cost details link inside the working settings shell. The unavailable panel has no dashboard placeholder height and renders no invented zero total or raw timeout. No production UI or financial logic change is necessary.

This branch extends the existing offline browser integration test to cover exactly 1180×757, plus 1440×900 and 390×844; repeated failure/retry; single message/action; compact panel bounds; and keyboard traversal between Retry usage and API cost details. Existing coverage includes loading, recovered loaded data, confirmed zero usage, unknown/partial summary, and stale comparison responses after month changes. All API data is local fixture data; the harness blocks writes and external requests.

## Preservation coverage

- Monthly scope and unknown-cost meaning: unchanged; tested before usage loads and with missing totals.
- Retry usage: unchanged read-only summary GET; tested with keyboard, repeated failure, and recovery.
- API cost details: unchanged `/console/apis` destination and keyboard access.
- Settings/account navigation: unchanged real settings component; shell presence tested. Full Next.js navigation/back behavior is outside the offline mocked-router harness.
- Currency, timestamps, calculations, current month selection, permissions, and execution safeguards: no runtime changes.
- Dialog/open-close: no dialog belongs to this unavailable panel. Optimization dialogs are unchanged.

## Evidence and limits

The PDF `CredX_Visual_Design_Simplicity_2026-11-01(1).pdf` (`libfile_e735fdf1e9f48191b47cf49a5af5b476`) and selection image `image(20261101-024935).png` (`libfile_0d924221bd9881918bf2e207ee2d05a9`) were resolved through the current Library materialization route. Its transfer helper returned `download failed` for both; neither file has readable local bytes. Pages 1–13, 97–100, 148 and their preservation-map images could not be inspected. This verification is grounded in the supplied assessment text and actual repository implementation; it does not claim visual comparison against inaccessible source images.

Browser screenshots are generated locally in `/tmp/cost-recovery-evidence` (`failed-1180.png`, `success-1180.png`, and equivalent 1440/390 files). They use fixture values, not production data. No live refresh, provider job, account change, merge or deploy is performed. Integration and serial deployment belong to the coordinator.

## Local results

- `node scripts/cost-usage-recovery-playwright.mjs`: PASS at all three viewport sizes.
- `npx eslint scripts/cost-usage-recovery-playwright.mjs app/console/profile/cost-drivers/CostUsageProvider.tsx`: PASS.
- `npx tsc --noEmit`: PASS.
- `node --test tests/trading-bots-navigation.test.mjs tests/fx-presentation.test.mjs`: 9 passed, 0 failed.
- `git diff --check`: PASS.

No shared runtime file is changed. The only executable change is the task-specific existing browser regression script; parallel automated-rebalance implementations have no overlapping edits from this branch.
