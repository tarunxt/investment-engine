# LLM-REPORT-COMPARISON implementation evidence

Base: `1089c6f1` (current origin/main on 2026-11-01). Route: `/console/llms`.

## Source provenance

The native reviewer visually inspected rendered PDF pages 89 and 91 and read
complete preservation map page 90 on 2026-11-01. The coordinator supplied that
reviewer's interpretation and full source text to this coding worker. Source:
`libfile_e735fdf1e9f48191b47cf49a5af5b476`. This worker did not see PDF images:
previous supported Library transfers of the PDF and selection image
`libfile_0d924221bd9881918bf2e207ee2d05a9` failed, including one bounded retry each.
No further Library retries were made. The mapping below follows the native
reviewer's verified requirements; implementation screenshots were separately
rendered and inspected locally by this worker.

## Complete page-90 mapping checklist

| Mapped record | Readback / implementation |
| --- | --- |
| LLM Performance | Existing h1 and small LLMs eyebrow retained within one pale rounded Report overview panel. |
| Scope: summarized and listwise LLM performance by scan type | Existing concise description retained; tested in rendered overview. |
| Reported dimensions: timestamps, runtime, processing pass/fail, Google Sheets export pass/fail, cost and captured errors | All dimensions retained in description and existing table renderers. |
| LLMs used | Dynamic `total_llms`; em dash before response, zero only for returned zero. No hardcoded 9. |
| Total scans | Dynamic `total_scans`; same handling. No hardcoded 1,000. |
| Generated | Existing `generated_at` formatter retained. No captured example timestamp. |
| Refresh | Existing read and disabled-during-load behavior; upper right at desktop and keyboard focus retained. |
| Historical export constraint | Clarifies historical/retired meaning; no Sheets navigation or integration restored. |

The single proposed view is represented by the overview panel and three compact
cards rather than a redundant inventory table. All three cards remain horizontal
at desktop width. No proposed tabs/dialogs or audit-only instructions were added.
Lower report tables were inventoried from current code and schemas, retained
without redesign, and exercised with fixtures. Values are never copied from PDF.

## Supplied-assessment coverage

| Item | Implementation / preservation |
| --- | --- |
| Compact title, explanation, three summary metrics | Preserved compact hierarchy and wider container in a pale rounded neutral overview panel; no global density changes. |
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
route revisit, all eight mapped overview records, horizontal containment, explicit pass/fail outcomes, cost fallback and keyboard focus at 1180×757 and
390×757. Screenshots are written to `/tmp/llm-report-evidence` by default.
No dialogs or report tabs exist in the current component. Full authenticated
shell/back-navigation remains unverified. Proposal interpretation comes from the native reviewer, not direct PDF image inspection by this worker.

The installed Next package does not include the requested `dist/docs` guide
files; this change does not add framework APIs. Initial dependency installation
failed because the default npm cache was not writable; installation succeeded
with a temporary writable cache. No dependency manifests changed.

Only the page, this evidence document and the dedicated offline harness change.
No shared automated-rebalance files are touched. Merge and deployment belong to
the coordinator. The PR remains draft for coordinated integration.
