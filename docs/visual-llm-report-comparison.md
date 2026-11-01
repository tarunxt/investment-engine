# LLM-REPORT-COMPARISON implementation evidence

Base: `1089c6f1` (current origin/main on 2026-11-01). Route: `/console/llms`.

## Source limitation

The resolved PDF `libfile_e735fdf1e9f48191b47cf49a5af5b476` and selection image
`libfile_0d924221bd9881918bf2e207ee2d05a9` were each prepared using the current
Library skill and its supplied transfer helper. Both byte transfers failed with
`library file transfer failed: download failed`. One bounded retry per file,
prepared for an explicitly consumer-local `/workspace/llm-report-source/retry`
destination, failed identically. No readable bytes or page images were obtained.
Common pages 1–13 and 148, pages 89–91, proposed tabs/states and the preservation
map therefore remain unverified. This is a partial implementation grounded in
the assessment text supplied with the task, not certification of the full design.

## Supplied-assessment coverage

| Item | Implementation / preservation |
| --- | --- |
| Compact title, explanation, three summary metrics | Preserved layout and wider container; no global density changes. |
| LLM count, scan count, generated timestamp | Same response fields; missing initial counts now show an em dash rather than zero. Confirmed empty responses still show zero. |
| Refresh | Same `getLlmPerformance({ limit: 1000 })` read and loading disablement; explicit keyboard focus. No new execution path. |
| Historical Sheets export outcomes | All existing labels/statuses remain. Added historical/retired explanation; no Sheets screen or action. |
| Lower model/job tables | Inspected actual page, TypeScript schemas and backend report response. No structural redesign or invented values. Summary overflow now scrolls on narrow layouts; both table regions support keyboard focus. |
| Timestamps, runtime, processing, export, cost, errors | Existing renderers and source fields preserved, including unknown pass/fail and verified-FX fallback. No backend/calculation/currency changes. |
| Initial loading/failure | Status announcement; no false zero or empty state. Error announced as alert with retry guidance. |
| Refresh failure / stale report | Retains existing last successful data and timestamp with an explicit potentially stale disclosure. Does not show confirmed empty text after a failed reload. |
| Partial data | Existing null field handling preserved. Backend response has no partial/stale flag, so no new completeness inference. |
| Navigation, permissions, safeguards | No route, auth, API or execution changes. No provider jobs, scans or live refreshes triggered. |

## Validation

Run from `frontend`:

```sh
node scripts/llm-report-offline-playwright.mjs
npm run lint -- app/console/llms/page.tsx scripts/llm-report-offline-playwright.mjs
npx tsc --noEmit
```

The offline Playwright harness bundles the real component and CSS, replaces
the report read and FX hook with fixtures, and blocks external browser requests.
It covers loading, initial failure, keyboard retry, loaded/unknown fields,
failed reload retaining data, successful empty response, repeated retries,
route revisit, horizontal containment and keyboard focus at 1180×757 and
390×757. Screenshots are written to `/tmp/llm-report-evidence` by default.
No dialogs or report tabs exist in the current component. Full authenticated
shell/back-navigation and mapped proposal parity remain unverified.

The installed Next package does not include the requested `dist/docs` guide
files; this change does not add framework APIs. Initial dependency installation
failed because the default npm cache was not writable; installation succeeded
with a temporary writable cache. No dependency manifests changed.

Only the page, this evidence document and the dedicated offline harness change.
No shared automated-rebalance files are touched. Merge and deployment belong to
the coordinator; this branch must remain a draft until source mapping is resolved.
